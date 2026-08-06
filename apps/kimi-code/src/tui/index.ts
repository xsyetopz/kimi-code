export { KimiTUI } from "./kimi-tui";
export type { KimiTUIStartupInput } from "./kimi-tui";
export type { KimiTUIOptions } from "./types";
export {
  createTerminalViewState,
  resolveTerminalActivityMode,
} from "./renderer/terminal-view-state";
export type {
  TerminalActivityMode,
  TerminalActivityView,
  TerminalAppView,
  TerminalDialogView,
  TerminalEditorView,
  TerminalQueueView,
  TerminalViewSource,
  TerminalViewState,
} from "./renderer/terminal-view-state";
export {
  InkTerminalView,
  encodeInkInput,
  projectInkEditor,
  projectInkActivity,
  projectInkQueue,
  projectInkTranscript,
} from "./renderer/ink/terminal-view";
export type {
  InkQueueProjection,
  InkEditorProjection,
  InkTerminalViewProps,
  InkTranscriptProjection,
} from "./renderer/ink/terminal-view";
export { mountInkTerminalRenderer } from "./renderer/ink/terminal-renderer";
export type {
  InkTerminalRenderer,
  InkTerminalRendererOptions,
} from "./renderer/ink/terminal-renderer";
export { TerminalOwnership } from "./renderer/terminal-owner";
export type { TerminalOwner } from "./renderer/terminal-owner";
export {
  createPromptEditorState,
  promptEditorLineColumn,
  reducePromptEditor,
} from "./renderer/prompt-editor-state";
export type {
  PromptCompletionState,
  PromptEditorAction,
  PromptEditorState,
  PromptInputMode,
} from "./renderer/prompt-editor-state";
export { routePromptEditorInput } from "./renderer/prompt-editor-input";
export type {
  PromptEditorRoute,
  PromptSemanticAction,
} from "./renderer/prompt-editor-input";
