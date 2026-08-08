import { homedir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { stdout as output } from "node:process";
import {
  SteeringQueue,
  classifyTask,
  composeToolExecutors,
  createBuiltinToolExecutor,
  createManualPermissionGate,
  createPrivilegePermissionGate,
  createYoloPermissionGate,
  formatReviewPanel,
  modelForTask,
  parseReviewModels,
  parseRouteTable,
  runAgentTurn,
  runReviewPanel,
  type AgentEvent,
  type PermissionMode,
  type SwarmWorkerSpec,
  type ToolPrivilege,
} from "@kimi-next/agent";
import {
  OPENROUTER_API_KEY_ENV,
  type Credential,
  listAuthStatus,
  loadCredentials,
  loginProvider,
  logoutProvider,
  resolveApiKey,
} from "@kimi-next/auth";
import type { Conversation } from "@kimi-next/ir";
import { type ModelProfile, resolveModel } from "@kimi-next/model";
import {
  append,
  applyCompact,
  buildCompactCheckpointFromConversation,
  createSession,
  forkSession,
  listSessions,
  load as loadSession,
  openSession,
} from "@kimi-next/session";
import {
  DEFAULT_TOGGLES,
  renderAssistantText,
  renderFooter,
  renderToolCall,
  renderToolResult,
  renderUserMessage,
  toggleKey,
  type WysiwygToggles,
} from "@kimi-next/tui";
import { adapterForTransport } from "./adapters";
import { helpText } from "./args";
import { shouldAutoCompact } from "./auto-compact";
import { refineCompactDraft } from "./compact";
import { expandMentions } from "./mentions";
import { loadMcpTools } from "./plugins";
import { type ReplContext } from "./repl";
import {
  activateInlineSkills,
  activateSkill,
  extractInlineSkillCalls,
  findSkill,
  formatSkillsMetadata,
  loadSkillsFromCwd,
  type SkillMeta,
} from "./skills";
import { liveSseStream } from "./stream";
import { type ActiveTask, createTask } from "./task";
import { ensureProjectTrust } from "./trust";
import { createHookHost } from "./hooks-host";
import { formatReceipt, type HarnessReceipt } from "./receipt";

export type HostLine =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; thinking?: string; raw?: string }
  | { kind: "tool"; name: string; id?: string }
  | { kind: "tool_result"; content: string; isError: boolean }
  | { kind: "system"; text: string }
  | { kind: "stream"; text: string };

export interface HostSnapshot {
  sessionId: string;
  modelId: string;
  effort?: string;
  permissionMode: string;
  baseUrl: string;
  transport: string;
  toggles: WysiwygToggles;
  lines: readonly HostLine[];
  streamingText: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  swarmLines: readonly string[];
  busy: boolean;
  planMode: boolean;
  receipt?: HarnessReceipt;
  permissionPrompt?: { toolName: string };
  notice?: string;
}

export interface InteractiveHost {
  getSnapshot(): HostSnapshot;
  subscribe(listener: () => void): () => void;
  submit(line: string): Promise<void>;
  answerPermission(answer: "y" | "n" | "a"): void;
  abort(): void;
  steer(text: string): void;
  dispose(): Promise<void>;
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function providerIdForModel(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash >= 0 ? modelId.slice(0, slash) : modelId;
}

export interface HostOptions {
  /** When true, never write agent events to stdout (Ink / external UI owns rendering). */
  readonly quiet?: boolean;
}

export function createInteractiveHost(
  ctx: ReplContext,
  options: HostOptions = {},
): InteractiveHost {
  const { args } = ctx;
  const quiet = options.quiet === true;
  const sessionDir = join(homedir(), ".kimi-next", "sessions");
  let profile = ctx.profile;
  let compactProfile = ctx.compactProfile;
  let adapter = ctx.adapter;
  let credentials: readonly Credential[] = ctx.credentials;
  let baseUrl = ctx.baseUrl;
  let permissionMode: PermissionMode = args.permissionMode;
  let effort: string | undefined;
  let activeSkillBody: string | undefined;
  let activeTask: ActiveTask | undefined;
  let skills: SkillMeta[] = [];
  let conversation: Conversation = [];
  let session: Awaited<ReturnType<typeof createSession>>;
  let mcp: Awaited<ReturnType<typeof loadMcpTools>> | undefined;
  let toolExecutor: ReturnType<typeof createBuiltinToolExecutor>;
  let hookHost: Awaited<ReturnType<typeof createHookHost>>;
  let activeAbortController: AbortController | undefined;
  let steering: SteeringQueue | undefined;
  let permissionWaiter: ((answer: "y" | "n" | "a") => void) | undefined;
  let pendingToolName: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let swarmLines: string[] = [];
  let streamingText = "";
  let busy = false;
  let notice: string | undefined;
  let planMode = args.plan === true;
  let lastReceipt: HarnessReceipt | undefined;
  let maxAutoPrivilege: ToolPrivilege = "read";
  const routeTable = parseRouteTable(process.env["KIMI_ROUTE_MODELS"]);
  let toggles: WysiwygToggles = {
    ...DEFAULT_TOGGLES,
    showThinking: args.showThinking,
    showRawAssistant: args.showRaw,
  };
  const lines: HostLine[] = [];
  const listeners = new Set<() => void>();
  const stickyPermissions = new Map<string, true>();
  const ready = (async () => {
    session = await createSession(sessionDir);
    conversation = await loadSession(session);
    hookHost = await createHookHost(process.cwd());
    const trusted = await ensureProjectTrust(process.cwd(), !args.rpc);
    skills = trusted ? await loadSkillsFromCwd(process.cwd()) : [];
    mcp = trusted ? await loadMcpTools(process.cwd()) : undefined;
    const swarmOptions = {
      runWorker: async (worker: SwarmWorkerSpec, prompt: string, workerToolNames: readonly string[] = []) => {
        const workerExecutor = createBuiltinToolExecutor(process.cwd());
        const workerTools = workerExecutor.definitions().filter((definition) => workerToolNames.includes(definition.name));
        const result = await runAgentTurn([], prompt, {
          profile: worker.profile,
          adapter: adapterForTransport(worker.profile.transport),
          tools: workerTools,
          toolExecutor: workerExecutor,
          permission: createYoloPermissionGate(),
          permissionMode: "yolo",
          generateId,
          stream: (wire, signal) => streamForProfile(worker.profile, wire, signal),
        });
        const last = [...result.conversation].reverse().find((record) => record.kind === "assistant");
        return last?.kind === "assistant" ? last.text.join("") : "";
      },
      onVisibility: (visibility: string) => {
        swarmLines = visibility.split("\n");
        emit({ type: "swarm", visibility });
      },
    };
    const builtin = createBuiltinToolExecutor(process.cwd(), swarmOptions);
    toolExecutor = mcp ? composeToolExecutors(builtin, mcp) : builtin;
  })();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function setNotice(text: string): void {
    notice = text;
    lines.push({ kind: "system", text });
    notify();
  }

  function emit(event: AgentEvent): void {
    if (event.type === "stream" && event.event.type === "usage") {
      inputTokens += event.event.inputTokens ?? 0;
      outputTokens += event.event.outputTokens ?? 0;
      cachedInputTokens += event.event.cachedInputTokens ?? 0;
    }
    if (args.jsonl) {
      console.log(JSON.stringify(event));
    }
    if (event.type === "user") {
      lines.push({ kind: "user", text: renderUserMessage(event.message) });
      if (!quiet && !args.jsonl) {
        output.write(`\n> ${renderUserMessage(event.message)}\n`);
      }
    } else if (event.type === "stream" && event.event.type === "text.delta") {
      streamingText += event.event.text;
      if (!quiet && !args.jsonl) output.write(event.event.text);
    } else if (event.type === "stream" && event.event.type === "tool.start") {
      lines.push({ kind: "tool", name: event.event.name, id: event.event.id });
      if (!quiet && !args.jsonl) {
        console.log(
          renderToolCall({
            id: event.event.id,
            name: event.event.name,
            arguments: "",
          }),
        );
      }
    } else if (event.type === "tool_result") {
      lines.push({
        kind: "tool_result",
        content: event.result.content,
        isError: event.result.isError,
      });
      if (!quiet && !args.jsonl) console.log(renderToolResult(event.result));
    } else if (event.type === "swarm") {
      swarmLines = event.visibility.split("\n");
    } else if (event.type === "assistant") {
      const thinking =
        event.turn.reasoning.mode === "exposed"
          ? event.turn.reasoning.text
          : undefined;
      const raw = event.turn.preserved.rawProviderMessage
        ? JSON.stringify(event.turn.preserved.rawProviderMessage)
        : undefined;
      const assistantLine: HostLine =
        thinking === undefined && raw === undefined
          ? { kind: "assistant", text: event.turn.text.join("") }
          : thinking !== undefined && raw !== undefined
            ? {
                kind: "assistant",
                text: event.turn.text.join(""),
                thinking,
                raw,
              }
            : thinking !== undefined
              ? {
                  kind: "assistant",
                  text: event.turn.text.join(""),
                  thinking,
                }
              : { kind: "assistant", text: event.turn.text.join(""), raw: raw! };
      lines.push(assistantLine);
      streamingText = "";
      if (!quiet && !args.jsonl) {
        output.write("\n");
        if (toggles.showThinking || toggles.showRawAssistant) {
          const rendered = renderAssistantText(
            event.turn.text.join(""),
            thinking,
            raw,
            toggles,
          );
          if (thinking || (toggles.showRawAssistant && raw)) {
            console.log(rendered);
          }
        }
      }
    }
    notify();
  }

  function streamForProfile(target: ModelProfile, wireBody: unknown, signal?: AbortSignal) {
    const apiKey = resolveApiKey(credentials, providerIdForModel(target.id));
    if (!apiKey) throw new Error(`No API key for ${providerIdForModel(target.id)}. Set OPENAI_API_KEY / ANTHROPIC_API_KEY.`);
    const options: { transport: typeof target.transport; baseUrl: string; apiKey: string; model?: string; signal?: AbortSignal } = { transport: target.transport, baseUrl, apiKey };
    if (target.transport === "gemini") options.model = target.wireModel;
    if (signal !== undefined) options.signal = signal;
    return liveSseStream(wireBody, options);
  }

  async function runCompact(): Promise<void> {
    await ready;
    await hookHost.hooks.preCompact?.({ conversationLength: conversation.length });
    const summarize = compactProfile === undefined ? undefined : async (draft: Parameters<typeof refineCompactDraft>[0]["draft"]) =>
      refineCompactDraft({ profile: compactProfile!, adapter: adapterForTransport(compactProfile!.transport), draft, stream: (wire, signal) => streamForProfile(compactProfile!, wire, signal), generateId });
    const checkpoint = await buildCompactCheckpointFromConversation(conversation, summarize ? { summarize } : undefined);
    conversation = applyCompact(conversation, checkpoint);
    await append(session, checkpoint);
    setNotice(args.jsonl ? "compact.complete" : "compact checkpoint appended (archive retained)");
  }

  async function runPrompt(prompt: string): Promise<void> {
    await ready;
    if (shouldAutoCompact(conversation, { threshold: args.autoCompactChars })) await runCompact();
    const expanded = await expandMentions(prompt, process.cwd());
    const inline = extractInlineSkillCalls(expanded.text, skills);
    const inlineSkillBody = await activateInlineSkills(inline.skillNames, skills);
    const beforeIds = new Set(conversation.map((record) => record.id));
    const parts: string[] = [];
    if (args.system !== undefined) parts.push(args.system);
    if (hookHost.instructionPrompt) parts.push(hookHost.instructionPrompt);
    if (effort) parts.push(`[Reasoning effort: ${effort}]`);
    const skillMeta = formatSkillsMetadata(skills);
    if (skillMeta) parts.push(skillMeta);
    if (activeSkillBody) parts.push(`[Active skill]\n${activeSkillBody}`);
    if (activeTask) parts.push(`[Active task: ${activeTask.title}]\n${activeTask.instruction}`);
    if (inlineSkillBody) parts.push(inlineSkillBody);
    if (planMode) {
      parts.push(
        "[Plan-only mode: discuss approaches; do not claim file edits. Tools are disabled until /implement.]",
      );
    }
    const controller = new AbortController();
    activeAbortController = controller;
    const activeSteering = new SteeringQueue();
    steering = activeSteering;
    const permissionInner =
      permissionMode === "yolo" || args.print || args.rpc
        ? createYoloPermissionGate()
        : createManualPermissionGate(async (request) => {
            if (stickyPermissions.has(request.toolName)) return "allow";
            const answer = await new Promise<"y" | "n" | "a">((resolve) => {
              permissionWaiter = resolve;
              pendingToolName = request.toolName;
              notify();
            });
            permissionWaiter = undefined;
            pendingToolName = undefined;
            if (answer === "a") {
              stickyPermissions.set(request.toolName, true);
              return "allow";
            }
            return answer === "y" ? "allow" : "deny";
          });
    const permission =
      permissionMode === "yolo" || args.print || args.rpc
        ? permissionInner
        : createPrivilegePermissionGate(permissionInner, maxAutoPrivilege);
    const taskClass = classifyTask(prompt, { planMode });
    const routedId = modelForTask(taskClass, routeTable);
    if (
      process.env["KIMI_ROUTE_MODELS"] &&
      routedId !== profile.id &&
      taskClass !== "implement"
    ) {
      try {
        const routed = resolveModel(routedId);
        profile = routed;
        adapter = adapterForTransport(routed.transport);
      } catch {
        // Keep current profile if routed id is unknown.
      }
    }
    const optional: { systemPrompt?: string; compactModelId?: string } = {};
    if (parts.length > 0) optional.systemPrompt = parts.join("\n\n");
    if (compactProfile !== undefined) optional.compactModelId = compactProfile.id;
    const tools = planMode ? [] : toolExecutor.definitions();
    const mcpCatalogCount = mcp
      ? mcp.definitions().filter((definition) => definition.name.startsWith("mcp:")).length
      : 0;
    const mcpFullSchemaCount = mcp?.fullSchemas().size ?? 0;
    const activatedSkills = [
      ...(activeSkillBody ? ["(sticky)"] : []),
      ...inline.skillNames,
    ];
    lastReceipt =
      hookHost.instructionKind === undefined
        ? {
            skillIndexCount: skills.length,
            activatedSkills,
            mcpCatalogCount,
            mcpFullSchemaCount,
            toolsExposed: tools.length,
            planMode,
            permissionMode,
          }
        : {
            skillIndexCount: skills.length,
            activatedSkills,
            mcpCatalogCount,
            mcpFullSchemaCount,
            toolsExposed: tools.length,
            planMode,
            permissionMode,
            instructionKind: hookHost.instructionKind,
          };
    const options: Parameters<typeof runAgentTurn>[2] = {
      profile,
      adapter,
      tools,
      toolExecutor,
      permission,
      permissionMode,
      generateId,
      stream: (wire, signal) => streamForProfile(profile, wire, signal),
      onEvent: emit,
      signal: controller.signal,
      hooks: hookHost.hooks,
      steering: activeSteering,
      ...optional,
    };
    try {
      busy = true;
      notify();
      const result = await runAgentTurn(conversation, inline.cleanText, options);
      conversation = result.conversation;
      for (const record of conversation) if (!beforeIds.has(record.id)) await append(session, record);
      if (!quiet && !args.jsonl) {
        const footerState: {
          modelId: string;
          permissionMode: string;
          inputTokens: number;
          outputTokens: number;
          cachedInputTokens: number;
          swarmLines?: readonly string[];
        } = {
          modelId: profile.id,
          permissionMode,
          inputTokens,
          outputTokens,
          cachedInputTokens,
        };
        if (toggles.showSwarmVisibility && swarmLines.length > 0) {
          footerState.swarmLines = swarmLines;
        }
        console.log(renderFooter(footerState, toggles));
        if (lastReceipt) console.log(formatReceipt(lastReceipt));
      }
    } finally {
      busy = false;
      activeAbortController = undefined;
      steering = undefined;
      streamingText = "";
      notify();
    }
  }

  async function command(line: string): Promise<boolean> {
    if (line === "/help") setNotice(helpText());
    else if (line === "/new") {
      await ready; session = await createSession(sessionDir); conversation = []; activeSkillBody = undefined; activeTask = undefined; inputTokens = 0; outputTokens = 0; cachedInputTokens = 0; setNotice(`new session ${session.id}`);
    } else if (line === "/sessions") {
      await ready; const sessions = await listSessions(sessionDir); setNotice(sessions.length === 0 ? "No sessions." : sessions.map((item) => item.id).join("\n"));
    } else if (line.startsWith("/resume ")) {
      try { await ready; session = await openSession(sessionDir, line.slice(8).trim()); conversation = await loadSession(session); setNotice(`resumed session ${session.id}`); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    } else if (line === "/fork") {
      try { await ready; session = await forkSession(session); conversation = await loadSession(session); setNotice(`forked session ${session.id}`); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    } else if (line === "/stop") { abort(); setNotice(activeAbortController ? "stopping current turn" : "no turn in flight"); }
    else if (line === "/compact" || line === "/segment") { try { await runCompact(); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } }
    else if (line === "/usage" || line === "/cost") {
      const usage = `usage: input=${inputTokens} output=${outputTokens} cached=${cachedInputTokens}`;
      setNotice(lastReceipt ? `${usage}\n${formatReceipt(lastReceipt)}` : usage);
    }
    else if (line === "/plan") {
      planMode = true;
      setNotice("plan mode on — tools disabled until /implement");
    }
    else if (line === "/implement") {
      planMode = false;
      setNotice("plan mode off — tools enabled");
    }
    else if (line.startsWith("/privilege ")) {
      const level = line.slice("/privilege ".length).trim();
      if (
        level === "read" ||
        level === "write" ||
        level === "exec" ||
        level === "mcp"
      ) {
        maxAutoPrivilege = level;
        setNotice(`auto-allow privilege ≤ ${level} (prompt text cannot elevate)`);
      } else {
        setNotice("usage: /privilege read|write|exec|mcp");
      }
    }
    else if (line.startsWith("/review")) {
      const topic = line.slice("/review".length).trim() || "Review the current conversation approach.";
      const models = parseReviewModels(process.env["KIMI_REVIEW_MODELS"]);
      const apiKey =
        resolveApiKey(credentials, "openrouter") ??
        process.env[OPENROUTER_API_KEY_ENV];
      if (!apiKey) {
        setNotice(`Set ${OPENROUTER_API_KEY_ENV} (or /login openrouter <key>) for /review`);
      } else if (models.length === 0) {
        setNotice("Set KIMI_REVIEW_MODELS=model/a,model/b for /review");
      } else {
        try {
          const opinions = await runReviewPanel({
            models,
            apiKey,
            messages: [
              {
                role: "system",
                content:
                  "You are a critical design/code reviewer. Be concrete. No fluff.",
              },
              { role: "user", content: topic },
            ],
          });
          setNotice(formatReviewPanel(opinions));
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error));
        }
      }
    }
    else if (line === "/provider") setNotice(`provider: ${profile.transport} · ${baseUrl}`);
    else if (line.startsWith("/base-url ")) { baseUrl = line.slice(10).trim() || baseUrl; setNotice(`base URL: ${baseUrl}`); }
    else if (line.startsWith("/effort ")) { effort = line.slice(8).trim() || undefined; setNotice(`effort: ${effort ?? "default"}`); }
    else if (line.startsWith("/model ")) { try { profile = resolveModel(line.slice(7).trim()); adapter = adapterForTransport(profile.transport); setNotice(`model: ${profile.id}`); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } }
    else if (line.startsWith("/export")) {
      await ready; const target = line.slice(7).trim() || `${session.id}.md`; const path = target.startsWith("/") ? target : join(process.cwd(), target);
      const markdown = conversation.map((record) => record.kind === "user" ? `## User\n\n${record.content.map((part) => part.type === "text" ? part.text : `[image: ${part.url}]`).join("\n")}` : record.kind === "assistant" ? `## Assistant\n\n${record.text.join("")}` : record.kind === "tool_result" ? `## Tool result\n\n${record.content}` : record.kind === "compact_checkpoint" ? `## Compact checkpoint\n\n${record.progress}\n\nNext: ${record.nextSteps}` : `## System\n\n${record.text}`).join("\n\n");
      await writeFile(path, `${markdown}\n`, "utf8"); setNotice(`exported conversation to ${path}`);
    } else if (line === "/diff") {
      await ready; const calls = [...conversation].reverse().flatMap((record) => record.kind === "assistant" ? record.toolCalls : []).filter((call) => /write|edit|patch/i.test(call.name)); setNotice(calls.length > 0 ? JSON.stringify(calls[0], null, 2) : "No write/edit tool call found.");
    } else if (line === "/task clear") { activeTask = undefined; setNotice("active task cleared"); }
    else if (line.startsWith("/task ")) { try { activeTask = createTask(line.slice(6)); await runCompact(); setNotice(`active task: ${activeTask.title}`); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } }
    else if (line === "/skills") { await ready; skills = await loadSkillsFromCwd(process.cwd()); setNotice(skills.length === 0 ? "No skills found in .kimi-next/skills or skills/" : skills.map((skill) => `${skill.name}: ${skill.description || "(no description)"}`).join("\n")); }
    else if (line.startsWith("/skill ")) {
      await ready;
      const name = line.slice(7).trim();
      const skill = findSkill(skills, name);
      if (!skill) {
        setNotice(`Unknown skill: ${name}`);
      } else {
        const activated = await activateSkill(skill);
        activeSkillBody = activated.body;
        setNotice(
          activated.truncated
            ? `activated skill: ${skill.name} (body truncated)`
            : `activated skill: ${skill.name}`,
        );
      }
    }
    else if (line === "/yolo") { permissionMode = "yolo"; setNotice("permission mode: yolo"); }
    else if (line === "/auth") { const statuses = await listAuthStatus(); setNotice(statuses.length === 0 ? "No auth providers configured." : statuses.map((status) => `${status.providerId} (${status.label}): ${status.configured ? status.kind : "not configured"}`).join("\n")); }
    else if (line.startsWith("/login ")) { const rest = line.slice(7).trim(); const space = rest.indexOf(" "); const provider = space >= 0 ? rest.slice(0, space) : rest; const apiKey = space >= 0 ? rest.slice(space + 1).trim() : undefined; try { const options: { apiKey?: string } = {}; if (apiKey) options.apiKey = apiKey; const result = await loginProvider(provider, options); setNotice(`${result.message}${result.authorizeUrl ? `\n${result.authorizeUrl}` : ""}`); credentials = await loadCredentials(); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } }
    else if (line.startsWith("/logout ")) { const provider = line.slice(8).trim(); try { await logoutProvider(provider); credentials = await loadCredentials(); setNotice(`logged out ${provider}`); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } }
    else if (line === "/toggle-thinking") { toggles = toggleKey(toggles, "showThinking"); setNotice(`showThinking=${toggles.showThinking}`); }
    else if (line === "/toggle-raw") { toggles = toggleKey(toggles, "showRawAssistant"); setNotice(`showRawAssistant=${toggles.showRawAssistant}`); }
    else return false;
    return true;
  }

  function getSnapshot(): HostSnapshot {
    const snapshot: HostSnapshot = {
      sessionId: session?.id ?? "",
      modelId: profile.id,
      permissionMode,
      baseUrl,
      transport: profile.transport,
      toggles,
      lines: [...lines],
      streamingText,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      swarmLines: [...swarmLines],
      busy,
      planMode,
    };
    if (effort !== undefined) {
      return finalizeSnapshot({ ...snapshot, effort });
    }
    return finalizeSnapshot(snapshot);
  }

  function finalizeSnapshot(base: HostSnapshot): HostSnapshot {
    let snapshot = base;
    if (lastReceipt !== undefined) {
      snapshot = { ...snapshot, receipt: lastReceipt };
    }
    if (permissionWaiter !== undefined && pendingToolName !== undefined) {
      snapshot = {
        ...snapshot,
        permissionPrompt: { toolName: pendingToolName },
      };
    }
    if (notice !== undefined) {
      snapshot = { ...snapshot, notice };
    }
    return snapshot;
  }

  function abort(): void { activeAbortController?.abort(); }
  function steer(text: string): void { if (text.trim()) steering?.pushSteer(text.trim()); }

  return {
    getSnapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async submit(line) {
      const text = line.trim();
      if (!text) return;
      if (busy && !text.startsWith("/")) { steer(text); return; }
      if (!(await command(text))) {
        try { await runPrompt(text); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
      }
    },
    answerPermission(answer) { permissionWaiter?.(answer); },
    abort,
    steer,
    async dispose() { abort(); await ready; if (mcp) await mcp.close(); listeners.clear(); },
  };
}
