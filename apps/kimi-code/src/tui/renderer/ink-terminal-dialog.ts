import { truncateToWidth } from "@moonshot-ai/kimi-code-tui";
import { Box, Text } from "ink";
import { createElement, type ReactNode } from "react";

import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  formatHelpPanelCommandLabel,
  sortHelpPanelCommands,
} from "../components/dialogs/help-panel-data.ts";
import { CURRENT_MARK, SELECT_POINTER } from "../constant/symbols.ts";
import { currentTheme } from "../theme/index.ts";
import type {
  TerminalDialogView,
  TerminalViewState,
} from "./terminal-view-state.ts";

type ApprovalDisplayBlock = NonNullable<
  TerminalDialogView["pendingApproval"]
>["data"]["display"][number];

function summarizeDisplayBlock(
  block: ApprovalDisplayBlock,
): string | undefined {
  switch (block.type) {
    case "brief":
      return block.text;
    case "shell":
      return `${block.command}${block.cwd === undefined ? "" : ` · ${block.cwd}`}`;
    case "file_op":
      return `${block.operation} ${block.path}`;
    case "file_content":
      return `write ${block.path}`;
    case "diff":
      return `edit ${block.path}`;
    case "url_fetch":
      return `${block.method ?? "GET"} ${block.url}`;
    case "search":
      return `search ${block.query}${block.scope === undefined ? "" : ` · ${block.scope}`}`;
    case "invocation":
      return `${block.kind} ${block.name}`;
    case "todo":
      return `${block.items.length} todo item${block.items.length === 1 ? "" : "s"}`;
    case "background_task":
      return `${block.kind} ${block.description}`;
    default:
      return;
  }
}

function approvalLines(
  dialog: TerminalDialogView,
  selectedIndex: number,
): readonly string[] {
  const request = dialog.pendingApproval;
  if (request === null) return [];
  const { data } = request;
  return [
    `Tool: ${data.tool_name}`,
    data.action,
    data.description,
    ...data.display
      .map(summarizeDisplayBlock)
      .filter((line): line is string => line !== undefined)
      .slice(0, 4)
      .map((line) => `  ${line}`),
    "",
    ...data.choices.map(
      (choice, index) =>
        `  ${index === selectedIndex ? SELECT_POINTER : String(index + 1)} ${choice.label}${choice.description === undefined ? "" : ` — ${choice.description}`}`,
    ),
    "↑↓ choose · Enter select · Esc reject",
  ];
}

function questionLines(
  dialog: TerminalDialogView,
  selectedIndex: number,
): readonly string[] {
  const request = dialog.pendingQuestion;
  if (request === null) return [];
  const question = request.data.questions[0];
  if (question === undefined) return ["Question required", "Esc cancel"];
  return [
    question.header ?? "Question",
    question.question,
    ...(question.body === undefined ? [] : [question.body]),
    ...question.options.map(
      (option, index) =>
        `  ${index === selectedIndex ? SELECT_POINTER : String(index + 1)} ${option.label}${option.description === undefined ? "" : ` — ${option.description}`}`,
    ),
    question.multi_select
      ? "Space select · Enter next"
      : "↑↓ choose · Enter next",
    "Esc cancel",
  ];
}

function trustLines(
  dialog: TerminalDialogView,
  selectedIndex: number,
): readonly string[] {
  if (dialog.trustPrompt === null) return [];
  const gated =
    dialog.trustPrompt.gatedMcpServers.length === 0
      ? "none"
      : dialog.trustPrompt.gatedMcpServers.join(", ");
  return [
    "Trust this folder?",
    dialog.trustPrompt.workDir,
    "Project MCP servers are enabled only in trusted folders.",
    `Gated servers: ${gated}`,
    `  ${selectedIndex === 0 ? SELECT_POINTER : " "} Trust this folder — enable project MCP servers`,
    `  ${selectedIndex === 1 ? SELECT_POINTER : " "} Don't trust — exit Kimi Code`,
    "↑↓ navigate · Enter select · Esc exit",
  ];
}

function sessionLines(
  dialog: TerminalDialogView,
  currentSessionId: string,
  selectedIndex: number,
): readonly string[] {
  const title = dialog.sessionsScope === "all" ? "All sessions" : "Sessions";
  if (dialog.loadingSessions) return [title, "Loading sessions…"];
  if (dialog.sessions.length === 0) {
    return [title, "No sessions found.", "Esc cancel"];
  }
  return [
    title,
    "↑↓ navigate · Enter select · Ctrl+A change scope · Esc cancel",
    ...dialog.sessions.slice(0, 8).map((session, index) => {
      const label = session.title ?? session.lastPrompt ?? session.id;
      const current = session.id === currentSessionId ? ` ${CURRENT_MARK}` : "";
      return `  ${index === selectedIndex ? SELECT_POINTER : " "} ${label}${current} · ${session.workDir}`;
    }),
  ];
}

function helpLines(
  dialog: TerminalDialogView,
  width = 80,
  maxVisible = 24,
): readonly string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const accent = (text: string): string => currentTheme.fg("primary", text);
  const dim = (text: string): string => currentTheme.fg("textDim", text);
  const muted = (text: string): string => currentTheme.fg("textMuted", text);
  const kbdColor = (text: string): string => currentTheme.fg("warning", text);
  const slashColor = (text: string): string => currentTheme.fg("primary", text);
  const shortcuts = DEFAULT_KEYBOARD_SHORTCUTS;
  const kbdWidth = Math.max(
    8,
    ...shortcuts.map((shortcut) => shortcut.keys.length),
  );
  const commands = sortHelpPanelCommands(dialog.helpCommands);
  const commandLabels = commands.map(formatHelpPanelCommandLabel);
  const commandWidth = Math.max(
    12,
    ...commandLabels.map((label) => label.length),
  );
  const lines: string[] = [
    accent("─".repeat(safeWidth)),
    currentTheme.boldFg("primary", " help ") +
      muted("· Esc / Enter / q to cancel · ↑↓ scroll · PgUp/PgDn page"),
    "",
    `  ${dim("Sure, Kimi is ready to help! Just send a message to get started.")}`,
    "",
    `  ${currentTheme.bold("Keyboard shortcuts")}`,
    ...shortcuts.map(
      (shortcut) =>
        `    ${kbdColor(shortcut.keys.padEnd(kbdWidth))} — ${dim(shortcut.description)}`,
    ),
    "",
    `  ${currentTheme.bold("Slash commands")}`,
    ...commands.map((command, index) => {
      const label = commandLabels[index] ?? `/${command.name}`;
      return `    ${slashColor(label.padEnd(commandWidth))} — ${dim(command.description)}`;
    }),
    "",
    accent("─".repeat(safeWidth)),
  ];

  const content = lines.slice(1, lines.length - 1);
  const visible = Math.max(5, Math.floor(maxVisible));
  if (content.length > visible) {
    const scrollTop = Math.max(
      0,
      Math.min(dialog.scrollTop, content.length - visible),
    );
    const slice = content.slice(scrollTop, scrollTop + visible);
    const scrollInfo = muted(
      ` showing ${String(scrollTop + 1)}-${String(scrollTop + slice.length)} of ${String(content.length)}`,
    );
    return [lines[0] ?? "", ...slice, scrollInfo, lines.at(-1) ?? ""].map(
      (line) => truncateToWidth(line, safeWidth),
    );
  }
  return lines.map((line) => truncateToWidth(line, safeWidth));
}

export interface InkHelpDialogProps {
  readonly dialog: TerminalDialogView;
  readonly width?: number;
  readonly maxVisible?: number;
}

/**
 * React-owned `/help` dialog. The parent coordinator supplies only the
 * renderer-neutral snapshot; no pi-tui component is mounted in this path.
 */
export function InkHelpDialog({
  dialog,
  width = 80,
  maxVisible = 24,
}: InkHelpDialogProps): ReactNode {
  const lines = helpLines(dialog, width, maxVisible);
  return createElement(
    Box,
    { flexDirection: "column" },
    ...lines.map((line, index) =>
      createElement(Text, { key: `help-${index}` }, line),
    ),
  );
}

export function projectInkDialogLines(
  view: TerminalViewState,
  selectedIndex = 0,
  width = 80,
  maxVisible = 24,
): readonly string[] {
  const { dialog } = view;
  if (dialog.pendingApproval !== null) {
    return approvalLines(dialog, selectedIndex);
  }
  if (dialog.pendingQuestion !== null) {
    return questionLines(dialog, selectedIndex);
  }
  switch (dialog.active) {
    case "trust-prompt":
      return trustLines(dialog, selectedIndex);
    case "session-picker":
      return sessionLines(dialog, view.app.sessionId, selectedIndex);
    case "help":
      return helpLines(dialog, width, maxVisible);
    default:
      return [];
  }
}
