import type { TransportAdapter } from "@kimi-next/adapters";
import type {
  AssistantTurn,
  Conversation,
  StreamEvent,
  ToolCall,
  ToolDefinition,
  ToolResult,
  UserMessage,
} from "@kimi-next/ir";
import {
  applyStreamEvent,
  assembleAssistantTurn,
  assertConversationInvariants,
  createTurnAssembler,
} from "@kimi-next/ir";
import type { ModelProfile } from "@kimi-next/model";
import { validateRequest } from "@kimi-next/model";
import { transformContext } from "@kimi-next/session";
import type { AgentHooks, PreCompactCallback } from "./hooks";
import type { PermissionGate, PermissionMode } from "./permission";
import { SteeringQueue } from "./steer";
import type { ToolExecutor } from "./tools";

export type AgentEvent =
  | { readonly type: "user"; readonly message: UserMessage }
  | { readonly type: "stream"; readonly event: StreamEvent }
  | { readonly type: "assistant"; readonly turn: AssistantTurn }
  | { readonly type: "tool_result"; readonly result: ToolResult }
  | { readonly type: "swarm"; readonly visibility: string }
  | { readonly type: "error"; readonly error: Error };

export interface AgentLoopOptions {
  readonly profile: ModelProfile;
  /** Optional secondary model for auxiliary tasks (e.g. compact refinement). */
  readonly secondaryModelId?: string;
  readonly compactModelId?: string;
  readonly adapter: TransportAdapter;
  readonly tools: readonly ToolDefinition[];
  readonly toolExecutor: ToolExecutor;
  readonly permission: PermissionGate;
  readonly permissionMode: PermissionMode;
  readonly systemPrompt?: string;
  readonly instructions?: string;
  readonly generateId: () => string;
  /** Injected stream for tests / live HTTP caller. */
  readonly stream: (
    wireBody: unknown,
    signal?: AbortSignal,
  ) => AsyncIterable<unknown>;
  readonly onEvent?: (event: AgentEvent) => void;
  readonly signal?: AbortSignal;
  readonly hooks?: AgentHooks;
  /** Host callback to invoke immediately before it compacts the archive. */
  readonly onPreCompact?: PreCompactCallback;
  /** Steer messages are inserted after the current tool batch. */
  readonly steering?: SteeringQueue;
}

export interface AgentLoopResult {
  readonly conversation: Conversation;
  readonly turns: number;
}

const startedLifecycles = new WeakSet<object>();

export function createAbortBridge(): {
  readonly signal: AbortSignal;
  readonly abort: (reason?: unknown) => void;
} {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
  };
}

/**
 * Mini-simple agent loop: append user → transformContext → stream → tools → repeat.
 * Never branches on provider/model names; profile + adapter own those.
 */
export async function runAgentTurn(
  archive: Conversation,
  userText: string,
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  if (!startedLifecycles.has(options)) {
    startedLifecycles.add(options);
    await options.hooks?.sessionStart?.();
  }
  const user: UserMessage = {
    kind: "user",
    id: options.generateId(),
    content: [{ type: "text", text: userText }],
  };
  await options.hooks?.userPromptSubmit?.(user);
  options.onEvent?.({ type: "user", message: user });

  let conversation: Conversation = [...archive, user];
  assertConversationInvariants(conversation);

  let turns = 0;
  const maxTurns = 32;

  while (turns < maxTurns) {
    turns += 1;
    options.signal?.throwIfAborted();

    validateRequest({
      profile: options.profile,
      tools: options.tools.length > 0,
    });

    const active = transformContext(conversation);
    const systemParts = [options.systemPrompt, options.instructions].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );

    const adapterRequest: {
      model: string;
      conversation: Conversation;
      tools: readonly ToolDefinition[];
      system?: string;
    } = {
      model: options.profile.wireModel,
      conversation: active,
      tools: options.tools,
    };
    if (systemParts.length > 0) {
      adapterRequest.system = systemParts.join("\n\n");
    }
    const wireBody = options.adapter.serialize(adapterRequest);

    const assembler = createTurnAssembler();
    const decoded = options.adapter.decodeStream(
      options.stream(wireBody, options.signal),
    );

    try {
      for await (const event of decoded) {
        options.signal?.throwIfAborted();
        applyStreamEvent(assembler, event);
        options.onEvent?.({ type: "stream", event });
      }
    } catch (error) {
      if (!options.signal?.aborted) throw error;
      const partial = assembleAssistantTurn(assembler, options.generateId());
      conversation = [...conversation, partial];
      assertConversationInvariants(conversation);
      options.onEvent?.({ type: "assistant", turn: partial });
      return { conversation, turns };
    }

    const turn = assembleAssistantTurn(assembler, options.generateId());
    conversation = [...conversation, turn];
    assertConversationInvariants(conversation);
    options.onEvent?.({ type: "assistant", turn });

    if (turn.toolCalls.length === 0) {
      return { conversation, turns };
    }

    const results = await executeToolCalls(turn.toolCalls, options);
    conversation = [...conversation, ...results];
    assertConversationInvariants(conversation);

    const steers = options.steering?.drainSteer() ?? [];
    for (const text of steers) {
      const steer: UserMessage = {
        kind: "user",
        id: options.generateId(),
        content: [{ type: "text", text }],
      };
      conversation = [...conversation, steer];
      options.onEvent?.({ type: "user", message: steer });
      await options.hooks?.userPromptSubmit?.(steer);
    }
  }

  throw new Error(`Agent exceeded max turns (${maxTurns})`);
}

async function executeToolCalls(
  calls: readonly ToolCall[],
  options: AgentLoopOptions,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const call of calls) {
    const decision = await options.permission.ask({
      toolName: call.name,
      arguments: call.arguments,
      mode: options.permissionMode,
    });
    if (decision !== "allow") {
      const denied: ToolResult = {
        kind: "tool_result",
        id: options.generateId(),
        callId: call.id,
        content: `Permission denied for tool ${call.name}`,
        isError: true,
      };
      results.push(denied);
      options.onEvent?.({ type: "tool_result", result: denied });
      continue;
    }
    const hookDecision = await options.hooks?.preToolUse?.(call);
    if (hookDecision?.action === "deny") {
      const denied: ToolResult = {
        kind: "tool_result",
        id: options.generateId(),
        callId: call.id,
        content: hookDecision.reason,
        isError: true,
      };
      results.push(denied);
      options.onEvent?.({ type: "tool_result", result: denied });
      continue;
    }
    const effectiveCall =
      hookDecision?.action === "modify"
        ? { ...call, arguments: hookDecision.arguments }
        : call;
    const result = await options.toolExecutor.execute(
      effectiveCall,
      options.generateId,
    );
    results.push(result);
    options.onEvent?.({ type: "tool_result", result });
    if (!result.isError) {
      await options.hooks?.postToolUse?.(effectiveCall, result);
    }
  }
  return results;
}
