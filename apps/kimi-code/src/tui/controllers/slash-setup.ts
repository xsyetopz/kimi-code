import type {
  KimiHarness,
  PluginCommandDef,
  Session,
  SkillSummary,
} from "@moonshot-ai/kimi-code-sdk";

import {
  BUILTIN_SLASH_COMMANDS,
  buildPluginSlashCommands,
  buildSkillSlashCommands,
  isExperimentalFlagEnabled,
  type KimiSlashCommand,
  type SkillListSession,
  sortSlashCommands,
} from "#/tui/commands";
import {
  FileMentionProvider,
  type SlashAutocompleteCommand,
} from "#/tui/components/editor/file-mention-provider";
import type { TUIState } from "#/tui/tui-state";
import { buildDedupedSkillPickerEntries } from "#/tui/utils/inline-skill";

export interface SlashSetupHost {
  readonly state: TUIState;
  readonly harness: KimiHarness;
  readonly engineV2: boolean;
  readonly fdPath: string | null;
  readonly skillCommandMap: Map<string, string>;
  readonly pluginCommandMap: Map<string, string>;

  refreshPromptCompletions(): void;
}

export class SlashSetupController {
  private skillCommands: readonly KimiSlashCommand[] = [];
  private pluginCommands: readonly KimiSlashCommand[] = [];
  private skillPickerEntries = buildDedupedSkillPickerEntries([]);

  constructor(private readonly host: SlashSetupHost) {}

  getSlashCommands(): readonly KimiSlashCommand[] {
    const builtins = sortSlashCommands(BUILTIN_SLASH_COMMANDS).filter(
      (command) => isExperimentalFlagEnabled(command.experimentalFlag),
    );
    return [...builtins, ...this.skillCommands, ...this.pluginCommands];
  }

  setupAutocomplete(): void {
    const slashCommands: SlashAutocompleteCommand[] =
      this.getSlashCommands().map((cmd) => {
        const completer = cmd.completeArgs;
        return {
          name: cmd.name,
          aliases: cmd.aliases,
          description: cmd.description,
          ...(cmd.argumentHint !== undefined
            ? { argumentHint: cmd.argumentHint }
            : {}),
          ...(completer !== undefined
            ? { getArgumentCompletions: (prefix: string) => completer(prefix) }
            : {}),
        };
      });
    const provider = new FileMentionProvider(
      slashCommands,
      this.host.state.appState.workDir,
      this.host.fdPath,
      this.host.state.appState.additionalDirs,
      () => this.host.state.appState.inputMode,
      this.skillPickerEntries,
    );
    this.host.state.editor.setAutocompleteProvider(provider);

    const argumentHints = new Map<string, string>();
    for (const cmd of slashCommands) {
      if (cmd.argumentHint === undefined) continue;
      argumentHints.set(cmd.name, cmd.argumentHint);
      for (const alias of cmd.aliases ?? []) {
        argumentHints.set(alias, cmd.argumentHint);
      }
    }
    this.host.state.editor.setArgumentHints(argumentHints);
    this.host.refreshPromptCompletions();
  }

  refreshSlashCommandAutocomplete(): void {
    this.setupAutocomplete();
  }

  async refreshSkillCommands(session?: SkillListSession): Promise<void> {
    if (session === undefined) {
      // v2 engine: skills live on the workspace handler, not the session, so
      // they are available before the first (lazy) session is created — the
      // workspace catalog is the same merged view a session would serve.
      if (this.host.engineV2) {
        try {
          const skills = await this.host.harness.listWorkspaceSkills(
            this.host.state.appState.workDir,
          );
          this.applySkillCommands(skills);
          return;
        } catch {
          return;
        }
      }
      this.skillCommands = [];
      this.skillPickerEntries = buildDedupedSkillPickerEntries([]);
      this.host.skillCommandMap.clear();
      this.setupAutocomplete();
      return;
    }

    let skills;
    try {
      skills = await session.listSkills();
    } catch {
      return;
    }
    this.applySkillCommands(skills);
  }

  private applySkillCommands(skills: readonly SkillSummary[]): void {
    const skillCommands = buildSkillSlashCommands(skills);
    this.skillCommands = skillCommands.commands;
    this.skillPickerEntries = buildDedupedSkillPickerEntries(skills);
    this.host.skillCommandMap.clear();
    for (const [commandName, skillName] of skillCommands.commandMap) {
      this.host.skillCommandMap.set(commandName, skillName);
    }
    this.setupAutocomplete();
  }

  async refreshPluginCommands(session?: Session): Promise<void> {
    if (session === undefined) {
      // v2 engine: the enabled plugin commands are an app-global live view,
      // available before the first (lazy) session is created.
      if (this.host.engineV2) {
        try {
          const defs = await this.host.harness.listPluginCommands();
          this.applyPluginCommands(defs);
          return;
        } catch {
          return;
        }
      }
      this.pluginCommands = [];
      this.host.pluginCommandMap.clear();
      this.setupAutocomplete();
      return;
    }

    let defs;
    try {
      defs = await session.listPluginCommands();
    } catch {
      return;
    }
    this.applyPluginCommands(defs);
  }

  private applyPluginCommands(defs: readonly PluginCommandDef[]): void {
    const pluginSlashCommands = buildPluginSlashCommands(defs);
    this.pluginCommands = pluginSlashCommands.commands;
    this.host.pluginCommandMap.clear();
    for (const [commandName, body] of pluginSlashCommands.commandMap) {
      this.host.pluginCommandMap.set(commandName, body);
    }
    this.setupAutocomplete();
  }
}
