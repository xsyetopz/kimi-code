import { Box, Static, type Key, Text, useInput, useStdout } from "ink";
import { createElement, type ReactNode, useEffect, useState } from "react";

import { SELECT_POINTER } from "../../constant/symbols";
import { InkDialogView } from "./components/dialogs/InkDialogView";
import { InkApprovalPreview } from "./components/dialogs/InkApprovalPreview";
import { InkFooter } from "./components/InkFooter";
import { InkQueue } from "./components/InkQueue";
import { splitInkTranscript } from "./transcript-split";
import type {
  TerminalActivityView,
  TerminalQueueView,
  TerminalViewState,
} from "../terminal-view-state";
import type { TranscriptEntry } from "../../types";
import { TranscriptEntryView } from "./components/TranscriptEntry";

export type InkTranscriptProjection = TranscriptEntry;

export interface InkQueueProjection {
  readonly messages: readonly string[];
  readonly hint: string | undefined;
}

export interface InkEditorProjection {
  readonly prompt: ">" | "!";
  readonly text: string;
  readonly cursorLine: number;
  readonly cursorColumn: number;
  readonly autocomplete: readonly string[];
}

export interface InkChromeProjection {
  readonly footer: string;
}

/** Footer chrome shared by every Ink frame. */
export function projectInkChrome(view: TerminalViewState): InkChromeProjection {
  const mode =
    view.app.permissionMode === "manual" ? "manual" : view.app.permissionMode;
  const plan = view.app.planMode ? " plan" : "";
  const effort =
    view.app.thinkingEffort === "off" ? "" : ` ${view.app.thinkingEffort}`;
  const context =
    view.app.maxContextTokens > 0
      ? ` · ctx ${Math.round(view.app.contextUsage * 100)}%`
      : "";
  return {
    footer: `${view.app.modelLabel} · ${mode}${plan}${effort}${context}`,
  };
}

/** Render the editor as data, keeping cursor coordinates renderer-neutral. */
export function projectInkEditor(
  editor: TerminalViewState["editor"],
): InkEditorProjection {
  return {
    prompt: editor.inputMode === "bash" ? "!" : ">",
    text: editor.text,
    cursorLine: editor.cursorLine,
    cursorColumn: editor.cursorColumn,
    autocomplete: editor.autocomplete,
  };
}

/** Project transcript entries, passing through the full typed data for rich rendering. */
export function projectInkTranscript(
  view: Pick<TerminalViewState, "transcript">,
): readonly InkTranscriptProjection[] {
  return view.transcript;
}

/** Project the activity pane's visible text while preserving its mode rules. */
export function projectInkActivity(
  activity: TerminalActivityView,
): string | undefined {
  if (
    activity.mode === "hidden" ||
    activity.mode === "idle" ||
    activity.mode === "session"
  ) {
    return;
  }
  const label =
    activity.mode.slice(0, 1).toUpperCase() + activity.mode.slice(1);
  return activity.tip === undefined ? label : `${label} · Tip: ${activity.tip}`;
}

/** Project queue rows and hints with the same policy as the kimi-tui queue pane. */
export function projectInkQueue(queue: TerminalQueueView): InkQueueProjection {
  if (queue.messages.length === 0) {
    return { messages: [], hint: undefined };
  }

  const messages = queue.messages.map((message) => {
    const singleLine = message.text.replaceAll(/\s+/gu, " ").trim();
    const prompt = message.mode === "bash" ? `$ ${singleLine}` : singleLine;
    return `  ${SELECT_POINTER} ${prompt}`;
  });
  const hasSteerable = queue.messages.some(
    (message) => message.mode !== "bash",
  );
  const canSteer = queue.canSteerImmediately && hasSteerable;
  let hint: string;
  if (queue.isCompacting && !queue.isStreaming) {
    hint = "  ↑ to edit · will send after compaction";
  } else if (canSteer) {
    hint = "  ↑ to edit · ctrl-s to steer immediately";
  } else {
    hint = "  ↑ to edit · will send after current task";
  }
  return { messages, hint };
}

export interface InkTerminalViewProps {
  readonly view: TerminalViewState;
  /** Receives canonical kimi-tui input sequences while Ink owns stdin. */
  readonly onInput?: (data: string) => void;
}

function dialogSelectionCount(view: TerminalViewState): number {
  if (view.dialog.pendingApproval !== null) {
    return view.dialog.pendingApproval.data.choices.length;
  }
  if (view.dialog.pendingQuestion !== null) {
    return view.dialog.pendingQuestion.data.questions[0]?.options.length ?? 0;
  }
  if (view.dialog.active === "trust-prompt") return 2;
  if (view.dialog.active === "session-picker") {
    return Math.min(8, view.dialog.sessions.length);
  }
  return 0;
}

function autocompleteIdentity(view: TerminalViewState): string {
  return `${view.editor.inputMode}:${view.editor.text}:${view.editor.autocomplete.join("\u0000")}`;
}

/**
 * Convert Ink's parsed key event back into the byte-oriented sequences that
 * the existing editor and reverse-RPC input listeners consume.  This keeps
 * input semantics in one place while the visual tree moves to React.
 */
export function encodeInkInput(input: string, key: Key): string {
  const special: ReadonlyArray<readonly [keyof Key, string]> = [
    ["return", key.shift ? "\n" : "\r"],
    ["escape", "\u001b"],
    ["tab", key.shift ? "\u001b[Z" : "\t"],
    ["backspace", "\u007f"],
    ["delete", "\u001b[3~"],
    ["upArrow", "\u001b[A"],
    ["downArrow", "\u001b[B"],
    ["rightArrow", "\u001b[C"],
    ["leftArrow", "\u001b[D"],
    ["home", "\u001b[H"],
    ["end", "\u001b[F"],
    ["pageUp", "\u001b[5~"],
    ["pageDown", "\u001b[6~"],
  ];
  for (const [name, sequence] of special) {
    if (key[name]) return sequence;
  }

  // Ink reports ctrl+letter as the letter name, including when the terminal
  // uses Kitty's CSI-u protocol. kimi-tui's key matcher expects C0 bytes.
  if (key.ctrl && input.length === 1) {
    const code = input.toLowerCase().charCodeAt(0);
    if (code >= 97 && code <= 122) {
      return String.fromCharCode(code - 96);
    }
    if (input === "-") return "\u001f";
  }

  // Preserve Alt/Meta as an ESC prefix, matching the sequence emitted by
  // terminals in the non-Kitty path.
  if (key.meta && input.length > 0) return `\u001b${input}`;
  return input;
}

/**
 * Initial Ink transcript/activity/queue/editor renderer. It deliberately
 * consumes only TerminalViewState so the remaining chrome can migrate without
 * coupling React components to the kimi-tui coordinator.
 */
export function InkTerminalView({
  view,
  onInput,
}: InkTerminalViewProps): ReactNode {
  const { stdout } = useStdout();
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const selectionCount = dialogSelectionCount(view);
  const autocompleteCount =
    selectionCount === 0 ? view.editor.autocomplete.length : 0;
  const autocompleteKey = autocompleteIdentity(view);
  // The completion list belongs to the current editor buffer. Resetting its
  // pointer when the buffer or list changes keeps Ink's visual pointer aligned
  // with the coordinator's completion selection, whose initial index is zero.
  useEffect(() => {
    setAutocompleteIndex(0);
  }, [autocompleteKey]);
  useInput((input, key) => {
    if (
      selectionCount === 0 &&
      autocompleteCount > 0 &&
      (key.upArrow || key.downArrow)
    ) {
      setAutocompleteIndex((current) => {
        const delta = key.upArrow ? -1 : 1;
        return (current + delta + autocompleteCount) % autocompleteCount;
      });
    }
    onInput?.(encodeInkInput(input, key));
  });
  const { staticEntries, liveEntries } = splitInkTranscript(view);
  const activity = projectInkActivity(view.activity);
  const queue = projectInkQueue(view.queue);
  const editor = projectInkEditor(view.editor);
  const chrome = projectInkChrome(view);
  const dialogWidth = Math.max(20, stdout.columns ?? 80);
  // Non-TTY renderers (snapshots/tests) do not have a meaningful viewport;
  // retain the legacy 24-row default there. Interactive terminals reserve
  // room for the transcript/editor chrome before sizing the help viewport.
  const dialogRows =
    stdout.isTTY === true ? Math.max(5, (stdout.rows ?? 24) - 8) : 24;
  if (view.approvalPreview !== null) {
    return createElement(InkApprovalPreview, {
      block: view.approvalPreview.block,
      scrollTop: view.approvalPreview.scrollTop,
      width: dialogWidth,
      height: Math.max(5, stdout.rows ?? 24),
    });
  }
  const dialog = createElement(InkDialogView, {
    view,
    width: dialogWidth,
    maxVisible: dialogRows,
  });
  const editorLines = editor.text.split("\n");
  const editorText = editorLines
    .map((line, index) => {
      if (index !== editor.cursorLine) return line;
      const cursor = Math.max(0, Math.min(editor.cursorColumn, line.length));
      return `${line.slice(0, cursor)}▌${line.slice(cursor)}`;
    })
    .join("\n");
  return createElement(
    Box,
    { flexDirection: "column" },
    staticEntries.length === 0
      ? null
      : createElement(
          Static,
          { items: staticEntries },
          (entry: InkTranscriptProjection) =>
            createElement(TranscriptEntryView, {
              key: entry.id,
              entry,
              workspaceDir: view.app.workDir,
            }),
        ),
    ...liveEntries.map((entry) =>
      createElement(TranscriptEntryView, {
        key: entry.id,
        entry,
        workspaceDir: view.app.workDir,
      }),
    ),
    activity === undefined ? null : createElement(Text, null, activity),
    createElement(InkQueue, { queue }),
    createElement(Text, null, `${editor.prompt} ${editorText}`),
    editor.autocomplete.length === 0
      ? null
      : createElement(
          Box,
          { flexDirection: "column", paddingLeft: 2 },
          ...editor.autocomplete.map((item, index) =>
            createElement(
              Text,
              {
                key: `autocomplete-${index}`,
                dimColor: index !== autocompleteIndex,
              },
              `${index === autocompleteIndex ? SELECT_POINTER : " "} ${item}`,
            ),
          ),
        ),
    dialog,
    createElement(InkFooter, { chrome }),
  );
}
