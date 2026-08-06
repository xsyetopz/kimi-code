/** Renderer-neutral help content shared by the rollback and Ink dialogs. */

export interface KeyboardShortcut {
  readonly keys: string;
  readonly description: string;
}

export interface HelpPanelCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
}

/** Static list — keep in sync with the global editor bindings. */
export const DEFAULT_KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
  { keys: "Shift-Tab", description: "Toggle plan mode" },
  {
    keys: "Ctrl-G",
    description: "Edit in external editor ($VISUAL / $EDITOR)",
  },
  {
    keys: "Ctrl-O",
    description: "Toggle tool output / compaction summary expansion",
  },
  {
    keys: "Ctrl-T",
    description: "Expand / collapse the todo list (when truncated)",
  },
  {
    keys: "Ctrl-S",
    description: "Steer — inject a follow-up during streaming",
  },
  { keys: "Shift-Enter / Ctrl-J", description: "Insert newline" },
  { keys: "Ctrl-C", description: "Interrupt stream / clear input" },
  { keys: "Ctrl-D", description: "Exit (on empty input)" },
  { keys: "Esc", description: "Close dialogs / interrupt streaming" },
  { keys: "↑ / ↓", description: "Browse input history" },
  { keys: "Enter", description: "Submit" },
];

export function sortHelpPanelCommands(
  commands: readonly HelpPanelCommand[],
): HelpPanelCommand[] {
  return [...commands].sort(compareHelpPanelCommands);
}

export function formatHelpPanelCommandLabel(command: HelpPanelCommand): string {
  const aliases =
    command.aliases.length === 0
      ? ""
      : ` (${command.aliases.map((alias) => `/${alias}`).join(", ")})`;
  return `/${command.name}${aliases}`;
}

function compareHelpPanelCommands(
  a: HelpPanelCommand,
  b: HelpPanelCommand,
): number {
  return (
    getHelpPanelCommandGroup(a.name) - getHelpPanelCommandGroup(b.name) ||
    a.name.localeCompare(b.name)
  );
}

function getHelpPanelCommandGroup(name: string): 0 | 1 {
  return name.startsWith("skill:") ? 1 : 0;
}
