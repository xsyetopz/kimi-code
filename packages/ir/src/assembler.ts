import type { StreamEvent } from "./events";
import type { AssistantTurn, ReasoningState, ToolCall } from "./types";

export interface TurnAssemblerState {
  text: string[];
  currentText: string;
  reasoningText: string;
  reasoningMode: ReasoningState["mode"];
  toolCalls: Map<string, { name: string; arguments: string; order: number }>;
  toolOrder: number;
  providerState: Record<string, unknown>;
  started: boolean;
  ended: boolean;
}

export function createTurnAssembler(): TurnAssemblerState {
  return {
    text: [],
    currentText: "",
    reasoningText: "",
    reasoningMode: "none",
    toolCalls: new Map(),
    toolOrder: 0,
    providerState: {},
    started: false,
    ended: false,
  };
}

export function applyStreamEvent(
  state: TurnAssemblerState,
  event: StreamEvent,
): void {
  switch (event.type) {
    case "response.start":
      state.started = true;
      break;
    case "response.end":
      flushText(state);
      state.ended = true;
      break;
    case "text.start":
      break;
    case "text.delta":
      state.currentText += event.text;
      break;
    case "text.end":
      flushText(state);
      break;
    case "reasoning.start":
      state.reasoningMode = "exposed";
      break;
    case "reasoning.delta":
      state.reasoningMode = "exposed";
      state.reasoningText += event.text;
      break;
    case "reasoning.end":
      break;
    case "tool.start":
      state.toolCalls.set(event.id, {
        name: event.name,
        arguments: "",
        order: state.toolOrder++,
      });
      break;
    case "tool.arguments.delta": {
      const call = state.toolCalls.get(event.id);
      if (!call) {
        throw new Error(`tool.arguments.delta for unknown id ${event.id}`);
      }
      call.arguments += event.argumentsDelta;
      break;
    }
    case "tool.end":
      if (!state.toolCalls.has(event.id)) {
        throw new Error(`tool.end for unknown id ${event.id}`);
      }
      break;
    case "usage":
      break;
    case "provider.state":
      Object.assign(state.providerState, event.state);
      break;
    default: {
      const _exhaustive: never = event;
      throw new Error(`Unhandled stream event: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function flushText(state: TurnAssemblerState): void {
  if (state.currentText.length > 0) {
    state.text.push(state.currentText);
    state.currentText = "";
  }
}

export function assembleAssistantTurn(
  state: TurnAssemblerState,
  id: string,
): AssistantTurn {
  flushText(state);
  const entries = [...state.toolCalls.entries()];
  entries.sort(
    (
      a: [string, { name: string; arguments: string; order: number }],
      b: [string, { name: string; arguments: string; order: number }],
    ) => a[1].order - b[1].order,
  );
  const toolCalls: ToolCall[] = entries.map(([callId, call]) => ({
    id: callId,
    name: call.name,
    arguments: call.arguments,
  }));

  let reasoning: ReasoningState;
  if (state.reasoningMode === "none") {
    reasoning = { mode: "none" };
  } else if (state.reasoningText.length > 0) {
    reasoning = { mode: state.reasoningMode, text: state.reasoningText };
  } else {
    reasoning = { mode: state.reasoningMode };
  }

  return {
    kind: "assistant",
    id,
    text: state.text,
    reasoning,
    toolCalls,
    partial: !state.ended,
    preserved:
      Object.keys(state.providerState).length > 0
        ? { rawProviderMessage: state.providerState }
        : {},
  };
}
