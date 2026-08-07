import type {
  KimiHarness,
  PromptPart,
  Session,
} from "@moonshot-ai/kimi-code-sdk";

import { MAIN_AGENT_ID } from "#/tui/constant/kimi-tui";
import type {
  AppState,
  LivePaneState,
  QueuedMessage,
  SteerInputItem,
  TranscriptEntry,
} from "#/tui/types";
import { formatErrorMessage } from "#/tui/utils/event-payload";
import type { ImageAttachmentStore } from "#/tui/utils/image-attachment-store";
import { rewriteMediaPlaceholders } from "#/tui/utils/image-placeholder";
import { nextTranscriptId } from "#/tui/utils/transcript-id";
import type { TUIState } from "../tui-state";
import type { SessionEventHandler } from "./session-event-handler";
import type { StreamingUIController } from "./streaming-ui";

interface SendMessageOptions {
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly hasMedia?: boolean;
}

/**
 * Flatten steer items into the payload `session.steer` expects: the
 * historical `'\n\n'`-joined string when nothing carries media, or a
 * merged part list when any item has extracted media parts (queued image
 * messages, or the editor draft after placeholder extraction).
 *
 * Items are separated by the historical `'\n\n'`, which merges into the
 * adjacent text part. The one exception is two touching media parts: a
 * standalone `{type:'text',text:'\n\n'}` between them would be rejected
 * by `normalizePromptInput` as an empty text part, so the separator is
 * dropped there (media parts are self-delimiting anyway).
 */
function combineSteerInput(
  items: readonly SteerInputItem[],
): string | PromptPart[] {
  const hasMedia = items.some(
    (item) => item.parts !== undefined && item.parts.length > 0,
  );
  if (!hasMedia) return items.map((item) => item.text).join("\n\n");
  const parts: PromptPart[] = [];
  for (const item of items) {
    const startsWithMedia =
      item.parts !== undefined &&
      item.parts.length > 0 &&
      item.parts[0]?.type !== "text";
    const lastIsMedia = parts.length > 0 && parts.at(-1)?.type !== "text";
    if (parts.length > 0 && !(lastIsMedia && startsWithMedia)) {
      appendSteerText(parts, "\n\n");
    }
    if (item.parts !== undefined && item.parts.length > 0) {
      for (const part of item.parts) {
        if (part.type === "text") appendSteerText(parts, part.text);
        else parts.push(part);
      }
    } else {
      appendSteerText(parts, item.text);
    }
  }
  return parts;
}

function appendSteerText(parts: PromptPart[], text: string): void {
  const last = parts.at(-1);
  if (last?.type === "text") {
    parts[parts.length - 1] = { type: "text", text: last.text + text };
    return;
  }
  parts.push({ type: "text", text });
}

export interface MessageQueueHost {
  readonly state: TUIState;
  readonly session: Session | undefined;
  readonly harness: KimiHarness;
  readonly engineV2: boolean;
  readonly deferUserMessages: boolean;
  readonly imageStore: ImageAttachmentStore;
  readonly streamingUI: StreamingUIController;
  readonly sessionEventHandler: SessionEventHandler;

  track(event: string, properties?: Parameters<KimiHarness["track"]>[1]): void;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  updateQueueDisplay(): void;
  updateInkRenderer(): void;
  validateMediaCapabilities(extraction: {
    hasMedia: boolean;
    imageAttachmentIds: readonly number[];
    videoAttachmentIds: readonly number[];
  }): boolean;

  ensureSession(): Promise<Session | undefined>;
  /** Non-async delegate returning the promise directly. */
  waitForLazyCreation(): Promise<void>;

  runShellCommandFromInput(command: string): Promise<void>;
}

export class MessageQueueController {
  constructor(private readonly host: MessageQueueHost) {}

  recallLastQueued(): QueuedMessage | undefined {
    if (this.host.state.queuedMessages.length === 0) return;
    const last = this.host.state.queuedMessages.at(-1)!;
    this.host.state.queuedMessages = this.host.state.queuedMessages.slice(
      0,
      -1,
    );
    return last;
  }

  enqueueMessage(
    text: string,
    options?: SendMessageOptions,
    mode?: "prompt" | "bash",
  ): void {
    this.host.state.queuedMessages.push({
      text,
      agentId: this.host.harness.interactiveAgentId,
      parts: options?.parts,
      imageAttachmentIds:
        options?.imageAttachmentIds !== undefined &&
        options.imageAttachmentIds.length > 0
          ? options.imageAttachmentIds
          : undefined,
      mode,
    });
    this.host.track("input_queue");
  }

  /** Queue a bash command and refresh the queue pane (handleUserInput / lazy-create busy gate). */
  enqueueBashCommand(text: string): void {
    this.enqueueMessage(text, undefined, "bash");
    this.host.updateQueueDisplay();
    this.host.state.ui.requestRender();
  }

  beginSessionRequest(): void {
    this.host.streamingUI.setTurnId(undefined);
    this.host.streamingUI.resetLiveText();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.resetToolCallState();

    this.host.patchLivePane({
      mode: "waiting",
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.host.setAppState({
      streamingPhase: "waiting",
      streamingStartTime: Date.now(),
    });
  }

  failSessionRequest(message: string): void {
    this.host.setAppState({ streamingPhase: "idle" });
    this.host.resetLivePane();
    this.host.showError(message);
  }

  sendQueuedMessage(session: Session, item: QueuedMessage): void {
    if (item.mode === "bash") {
      void this.host.runShellCommandFromInput(item.text);
      return;
    }
    this.host.harness.withInteractiveAgent(item.agentId ?? MAIN_AGENT_ID, () => {
      this.sendMessageInternal(session, item.text, {
        parts: item.parts,
        imageAttachmentIds: item.imageAttachmentIds,
      });
    });
  }

  requestQueuedGoalPromotion(): void {
    this.host.sessionEventHandler.requestQueuedGoalPromotion();
  }

  sendMessage(
    session: Session,
    input: string,
    options?: SendMessageOptions,
  ): void {
    if (
      this.host.deferUserMessages ||
      this.host.state.appState.streamingPhase !== "idle" ||
      this.host.state.appState.isCompacting
    ) {
      this.enqueueMessage(input, options);
      return;
    }
    this.sendMessageInternal(session, input, options);
  }

  sendSkillActivation(
    session: Session,
    skillName: string,
    skillArgs: string,
  ): void {
    // Args are a plain-text channel, so pasted media can't ride along as
    // inline parts. Skill args are XML-escaped on render (renderSkillAttributes
    // + expandSkillParameters), so rewrite placeholders into escape-proof
    // plain-text file references the model can open with ReadMediaFile.
    let rewrite: ReturnType<typeof rewriteMediaPlaceholders>;
    try {
      rewrite = rewriteMediaPlaceholders(
        skillArgs,
        this.host.imageStore,
        "plain",
      );
    } catch (error) {
      // Cache copy failed (unwritable cache dir, vanished video source…);
      // nothing has been dispatched yet, so just report and keep the input.
      this.host.showError(
        `Failed to prepare media attachment: ${formatErrorMessage(error)}`,
      );
      return;
    }
    if (!this.host.validateMediaCapabilities(rewrite)) return;
    this.beginSessionRequest();
    void session
      .activateSkill(skillName, rewrite.text)
      .catch((error: unknown) => {
        const message = formatErrorMessage(error);
        this.failSessionRequest(`Skill "${skillName}" failed: ${message}`);
      });
  }

  sendInlineSkillActivation(
    session: Session,
    invocations: readonly { skillName: string; args: string }[],
    userText: string,
  ): void {
    this.beginSessionRequest();
    void session
      .activateInlineSkills(
        invocations.map((invocation) => ({
          name: invocation.skillName,
          ...(invocation.args.length > 0 ? { args: invocation.args } : {}),
        })),
        userText,
      )
      .catch((error: unknown) => {
        const message = formatErrorMessage(error);
        this.failSessionRequest(`Inline skill activation failed: ${message}`);
      });
  }

  activatePluginCommand(
    session: Session,
    pluginId: string,
    commandName: string,
    args: string,
  ): void {
    // Plugin command args are expanded verbatim (no XML escaping), so the
    // standard <image|video path> tag convention works — see
    // sendSkillActivation for the escaped-channel variant.
    let rewrite: ReturnType<typeof rewriteMediaPlaceholders>;
    try {
      rewrite = rewriteMediaPlaceholders(args, this.host.imageStore, "tag");
    } catch (error) {
      this.host.showError(
        `Failed to prepare media attachment: ${formatErrorMessage(error)}`,
      );
      return;
    }
    if (!this.host.validateMediaCapabilities(rewrite)) return;
    this.beginSessionRequest();
    void session
      .activatePluginCommand(pluginId, commandName, rewrite.text)
      .catch((error: unknown) => {
        const message = formatErrorMessage(error);
        this.failSessionRequest(
          `Command "${pluginId}:${commandName}" failed: ${message}`,
        );
      });
  }

  steerMessage(session: Session, input: readonly SteerInputItem[]): void {
    if (this.host.deferUserMessages || this.host.state.appState.isCompacting) {
      for (const item of input) {
        this.enqueueMessage(item.text, item);
      }
      return;
    }
    if (this.host.state.appState.streamingPhase === "idle") {
      for (const item of input) {
        this.sendMessageInternal(session, item.text, item);
      }
      return;
    }

    for (const item of input) {
      this.host.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: "user",
        turnId: this.host.streamingUI.getTurnContext().turnId,
        renderMode: "plain",
        content: item.text,
        imageAttachmentIds:
          item.imageAttachmentIds !== undefined &&
          item.imageAttachmentIds.length > 0
            ? item.imageAttachmentIds
            : undefined,
      });
    }

    void session.steer(combineSteerInput(input)).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.host.showError(`Failed to steer: ${message}`);
    });
  }

  clearQueuedMessages(): void {
    this.host.state.queuedMessages = [];
    this.host.updateQueueDisplay();
    this.host.updateInkRenderer();
  }

  shiftQueuedMessage(): QueuedMessage | undefined {
    if (this.host.state.queuedMessages.length === 0) return;
    const [first, ...rest] = this.host.state.queuedMessages;
    this.host.state.queuedMessages = rest;
    this.host.updateQueueDisplay();
    this.host.updateInkRenderer();
    return first;
  }

  drainOneQueuedMessage(): void {
    const item = this.shiftQueuedMessage();
    if (item === undefined) return;
    const session = this.host.session;
    if (session === undefined) return;
    if (item.mode === "bash") {
      void this.host.runShellCommandFromInput(item.text);
    } else {
      this.sendQueuedMessage(session, item);
    }
    this.host.updateQueueDisplay();
  }

  private sendMessageInternal(
    session: Session,
    input: string,
    options?: SendMessageOptions,
  ): void {
    const imageAttachmentIds =
      options?.imageAttachmentIds !== undefined &&
      options.imageAttachmentIds.length > 0
        ? options.imageAttachmentIds
        : undefined;
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: "user",
      turnId: undefined,
      renderMode: "plain",
      content: input,
      imageAttachmentIds,
    });

    this.beginSessionRequest();

    const sdkInput = options?.parts ?? input;
    // While a goal is being pursued the engine holds its active turn across the
    // whole continuation loop, so a fresh prompt races the goal driver at every
    // continuation boundary and is rejected with `turn.agent_busy`, dropping
    // the message. Steer instead: the engine buffers it into the running goal
    // turn, or launches a turn of its own if the loop just ended.
    if (this.host.state.appState.goal?.status === "active") {
      void session.steer(sdkInput).catch((error: unknown) => {
        const message = formatErrorMessage(error);
        // Same reset as the prompt path: beginSessionRequest already moved the
        // TUI to the waiting phase, and no turn events may follow a failed
        // steer (e.g. the session is gone), which would leave the UI stuck
        // queueing input behind a request that never completes.
        this.failSessionRequest(`Failed to steer: ${message}`);
      });
      return;
    }
    void session.prompt(sdkInput).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.failSessionRequest(`Failed to send: ${message}`);
    });
  }
}
