/**
 * `profile` domain — `IAgentProfileService` implementation.
 *
 * Owns the active agent's model alias, thinking level, system prompt, and
 * active-tool set; reads the bound model's pure data through the App-scope
 * `IModelCatalog` and produces the dialect-free per-turn intent
 * (`resolveRequestParams`: cache key / sampling / thinking effort+keep —
 * wire encoding is each dialect's own hook), persists the profile binding
 * (`cwd` / `modelAlias` / `profileName` / resolved base `thinkingLevel` /
 * `systemPrompt` / injected AGENTS.md paths / `activeToolNames` / profile
 * `disallowedTools` / profile `subagents`) in the `wire` `ProfileModel` through
 * the `profile.bind` Op
 * (later slice updates ride the `config.update` Op) and the persisted
 * active-tool set in the `wire` `ActiveToolsModel` through the
 * `tools.set_active_tools` / `tools.reset_active_tools` Ops (`wire.dispatch`),
 * and reads both through
 * `wire.getModel`. The effective active-tool set read by consumers is the
 * persisted base (`ActiveToolsModel`, rebuilt by `wire.replay`) overlaid with
 * the ephemeral per-tool deltas from `addActiveTool` / `removeActiveTool`
 * (intentionally not persisted, re-derived on resume); the
 * live overlay is held in `agentState` and falls back to the Model when unset,
 * so no restore-ordering coupling arises. Profile and client
 * policy are persisted independently. The `agent.status.updated`
 * / `warning` events ride `IEventBus`. `emitStatusUpdated` runs live-only
 * after the dispatch, so
 * `wire.replay` rebuilds the Models silently; the same live-only path records
 * the resolved model alias whenever it changes.
 * `bind()` is first-bind only — a profile is the session's identity: the
 * guard runs before name resolution so `already bound` fails fast, and again
 * in the synchronous segment before the first dispatch, so concurrent binds
 * cannot both pass (an edge-level guard always leaves an interleaving
 * window); a same-name rebind keeps the persisted thinking effort unless the
 * caller explicitly overrides it. The AGENTS.md portion of the system-prompt
 * context comes from the seeded `ISessionInstructionsProvider` (the
 * workspace handler's shared, watch-refreshed snapshot — the working
 * directory is always the session's frozen cwd, so the snapshot always
 * applies), and the provider's change event drives a `refreshSystemPrompt`. Prompt builds inject the enabled plugins'
 * system-prompt sections (budget-capped, see `PLUGIN_SECTIONS_MAX_BYTES`);
 * plugin changes reach the prompt when the skill catalog re-pulls its plugin
 * source on explicit plugin reload (the Workspace-scope catalog forwards the
 * plugin source's change through the session seed) — the same point where
 * plugin skills take effect. The builtin source is refreshed on the same
 * signal: it changes only when its config switch is toggled, so it costs what
 * a config edit costs, unlike the file-backed sources whose fs watches would
 * rebuild every agent's prompt on each edit. Subscribing to the catalog rather
 * than to the config section matters — the catalog fires after the
 * contribution is replaced, so the rebuilt prompt cannot read the old listing. `refreshSystemPrompt` never rejects: a
 * failed context build keeps the current prompt and surfaces a warning,
 * because the `[tools]` config watcher fires it voided (an unhandled
 * rejection would crash kap-server) and the Session tool-policy fan-out
 * awaits it across agents. Tool-policy entries that can never activate
 * anything (typo'd names, wildcards without the `mcp__` prefix, incomplete
 * `mcp__` literals) surface as `warning` events instead of silently shrinking
 * the tool set; the known-name vocabulary is the live registry plus
 * builtin-profile literal names — deliberately not the session catalog, so a
 * typo in one agent file cannot legitimize the same typo in another, and
 * flag-gated tools (which every builtin profile lists) stay "known" even when
 * unregistered.
 * The mutable plain-data state (`activeToolNamesOverlay` / `agentsMdWarning`
 * / the three emitted-warning dedupe sets) is registered into `agentState`
 * (`IAgentStateService`) and read/written through it; `optionsValue` (holds
 * the `cwd` / `emitStatusUpdated` callbacks) and `activeProfile`
 * (a `ResolvedAgentProfile` carrying the `systemPrompt` function) stay plain
 * fields because the container only holds pure data structures. After every
 * successful bind / apply / refresh (never before the new prompt commits,
 * so a failed build cannot poison the set), the injected AGENTS.md paths are
 * seeded into `agentsMdReminder`'s known-set with the effective cwd. Fills the
 * prompt's product-name slot from the `agentIdentity` snapshot — frozen for
 * the process, so no `[identity]` subscription belongs here; the template's
 * own default applies when nothing is configured. `bind` gates on the freeze
 * before materializing the model, whose resolution reads the identity through
 * the host-headers port — a fast bootstrap must wait, not trip the pre-freeze
 * guard. Bound at Agent scope.
 */

import { Disposable } from "#/_base/di/lifecycle";
import {
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from "#/_base/di/scope";
import { defineState } from "#/_base/state/stateRegistry";
import {
  UNKNOWN_CAPABILITY,
  type ModelCapability,
} from "#/kosong/contract/capability";
import {
  type SamplingOptions,
  type ThinkingEffort,
} from "#/kosong/contract/provider";
import { IModelCatalog, type Model } from "#/kosong/model/catalog";
import { type ModelOverrides } from "#/kosong/model/model.types";
import { type ModelRequestParams } from "#/kosong/model/modelRequester";
import { IProtocolAdapterRegistry } from "#/kosong/protocol/protocol";
import {
  drivesThinkingThroughTraits,
  modelSupportsThinkingEffort,
  normalizeRequestedThinkingEffort,
  resolveForcedThinkingEffort,
  resolveThinkingEffortForModel,
  resolveThinkingKeep,
  requiresStrictThinkingValidation,
  type ThinkingConfig,
} from "#/kosong/model/thinking";
import { THINKING_SECTION } from "#/app/kosongConfig/configSection";
import { DEFAULT_AGENT_PROFILE_NAME } from "#/app/agentProfileCatalog/agentProfileCatalog";
import { IBuiltinAgentProfileLoader } from "#/app/agentProfileCatalog/builtinAgentProfileLoader";
import { ErrorCodes, Error2 } from "#/errors";
import { IAgentIdentity } from "#/app/agentIdentity/agentIdentity";
import { IBootstrapService } from "#/app/bootstrap/bootstrap";
import { IConfigService } from "#/app/config/config";
import type { LoopControl } from "#/agent/loop/configSection";
import { IHostEnvironment } from "#/os/interface/hostEnvironment";
import { IHostClock } from "#/os/interface/hostClock";
import { IHostFileSystem } from "#/os/interface/hostFileSystem";
import { ISessionContext } from "#/session/sessionContext/sessionContext";
import type { ToolSource } from "#/tool/toolContract";
import { ISessionWorkspaceContext } from "#/session/workspaceContext/workspaceContext";
import { ISessionInstructionsProvider } from "#/session/sessionInstructions/instructionsProvider";
import { ISessionSkillCatalog } from "#/session/sessionSkillCatalog/skillCatalog";
import {
  BUILTIN_SKILL_SOURCE_ID,
  PLUGIN_SKILL_SOURCE_ID,
} from "#/app/skillCatalog/skillSource";
import { ISessionAgentProfileCatalog } from "#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog";
import { ISessionToolPolicy } from "#/session/sessionToolPolicy/sessionToolPolicy";
import { ISessionToolPolicyGate } from "#/session/sessionToolPolicyGate/sessionToolPolicyGate";
import { IPluginService } from "#/app/plugin/plugin";
import type {
  ResolvedAgentProfile,
  SystemPromptContext,
} from "#/agent/profile/profile";
import { IAgentStateService } from "#/agent/state/agentState";
import { IAgentAgentsMdReminderService } from "#/agent/agentsMdReminder/agentsMdReminder";

import { IWireService } from "#/wire/wire";
import type { PayloadOf } from "#/wire/types";
import { IEventBus } from "#/app/event/eventBus";
import {
  extractAgentsMdPathsFromSystemPrompt,
  prepareSystemPromptContext,
  type LoadedAgentsMd,
} from "./context";
import type {
  ApplyProfileOptions,
  BindAgentInput,
  ProfileBindingSnapshot,
  ProfileData,
  ProfileModelContext,
  ProfileServiceOptions,
  ProfileSetModelResult,
  ProfileUpdateData,
} from "./profile";
import { IAgentProfileService, ProfileError, ProfileErrors } from "./profile";
import {
  TOOLS_SECTION,
  type ToolsConfig,
} from "#/agent/toolPolicy/configSection";
import {
  isToolActiveComposed,
  findInactiveToolPatterns,
  literalToolNames,
  type InactiveToolPattern,
} from "#/agent/toolPolicy/evaluate";
import { IAgentToolRegistryService } from "#/agent/toolRegistry/toolRegistry";
import { getAgentToolContributions } from "#/agent/toolRegistry/toolContribution";
import {
  ActiveToolsModel,
  configUpdate,
  profileBind,
  ProfileModel,
  setActiveTools,
  resetActiveTools,
  type ActiveToolsState,
  type ProfileModelState,
} from "./profileOps";

import * as ps from "./profileService.shared";

export const profileActiveToolNamesOverlayKey = defineState<
  readonly string[] | undefined
>(
  "profile.activeToolNamesOverlay",
  () => undefined as readonly string[] | undefined,
);
export const profileAgentsMdWarningKey = defineState<string | undefined>(
  "profile.agentsMdWarning",
  () => undefined as string | undefined,
);
export const profileEmittedThinkingEffortWarningsKey = defineState<Set<string>>(
  "profile.emittedThinkingEffortWarnings",
  () => new Set(),
);
export const profileEmittedToolPatternWarningsKey = defineState<Set<string>>(
  "profile.emittedToolPatternWarnings",
  () => new Set(),
);
export const profileEmittedPluginBudgetWarningsKey = defineState<Set<string>>(
  "profile.emittedPluginBudgetWarnings",
  () => new Set(),
);

export class AgentProfileServiceCore
  extends Disposable
  implements IAgentProfileService
{
  declare readonly _serviceBrand: undefined;

  private optionsValue: ProfileServiceOptions = {};

  private get activeToolNames(): ActiveToolsState {
    return (
      this.activeToolNamesOverlay ??
      (this.wire.getModel(ActiveToolsModel) as ActiveToolsState)
    );
  }

  private activeProfile: ResolvedAgentProfile | undefined;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,    @IConfigService private readonly config: IConfigService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IProtocolAdapterRegistry
    private readonly protocolAdapters: IProtocolAdapterRegistry,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @IHostClock private readonly clock: IHostClock,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionWorkspaceContext
    private readonly workspace: ISessionWorkspaceContext,
    @ISessionAgentProfileCatalog
    private readonly catalog: ISessionAgentProfileCatalog,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @ISessionInstructionsProvider
    private readonly instructions: ISessionInstructionsProvider,
    @ISessionToolPolicy private readonly sessionToolPolicy: ISessionToolPolicy,
    @ISessionToolPolicyGate
    private readonly toolPolicyGate: ISessionToolPolicyGate,
    @IAgentToolRegistryService
    private readonly toolRegistry: IAgentToolRegistryService,
    @IBuiltinAgentProfileLoader
    private readonly builtinProfiles: IBuiltinAgentProfileLoader,
    @IAgentStateService private readonly states: IAgentStateService,
    @IPluginService private readonly plugins: IPluginService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
    @IAgentAgentsMdReminderService
    private readonly agentsMdReminder: IAgentAgentsMdReminderService,
  ) {
    super();
    this.states.register(profileActiveToolNamesOverlayKey);
    this.states.register(profileAgentsMdWarningKey);
    this.states.register(profileEmittedThinkingEffortWarningsKey);
    this.states.register(profileEmittedToolPatternWarningsKey);
    this.states.register(profileEmittedPluginBudgetWarningsKey);
    this.configure({});
    this._register(
      this.sessionToolPolicy.onDidChange((event) => {
        event.waitUntil(this.refreshSystemPrompt());
      }),
    );
    this._register(
      this.instructions.onDidChange(() => {
        void this.refreshSystemPrompt();
      }),
    );
    this._register(
      this.config.onDidSectionChange(({ domain }) => {
        if (domain === TOOLS_SECTION) {
          this.publishToolPatternWarnings();
          void this.refreshSystemPrompt();
        }
      }),
    );
    this._register(
      this.skillCatalog.onDidChange((sourceId) => {
        if (
          sourceId === PLUGIN_SKILL_SOURCE_ID ||
          sourceId === BUILTIN_SKILL_SOURCE_ID
        ) {
          void this.refreshSystemPrompt();
        }
      }),
    );
  }

  private get activeToolNamesOverlay(): readonly string[] | undefined {
    return this.states.get(profileActiveToolNamesOverlayKey);
  }

  private set activeToolNamesOverlay(value: readonly string[] | undefined) {
    this.states.set(profileActiveToolNamesOverlayKey, value);
  }

  private get agentsMdWarning(): string | undefined {
    return this.states.get(profileAgentsMdWarningKey);
  }

  private set agentsMdWarning(value: string | undefined) {
    this.states.set(profileAgentsMdWarningKey, value);
  }

  private get emittedThinkingEffortWarnings(): Set<string> {
    return this.states.get(profileEmittedThinkingEffortWarningsKey);
  }

  private get emittedToolPatternWarnings(): Set<string> {
    return this.states.get(profileEmittedToolPatternWarningsKey);
  }

  private get emittedPluginBudgetWarnings(): Set<string> {
    return this.states.get(profileEmittedPluginBudgetWarningsKey);
  }

  configure(options: ProfileServiceOptions): void {
    this.optionsValue = {
      emitStatusUpdated:
        options.emitStatusUpdated ?? this.optionsValue.emitStatusUpdated,
    };
  }

  update(changed: ProfileUpdateData): void {
    const { activeToolNames, ...configChanged } = changed;
    if (
      changed.profileName !== undefined &&
      this.activeProfile?.name !== changed.profileName
    ) {
      this.activeProfile = undefined;
    }
    if (Object.keys(configChanged).length > 0) {
      this.wire.dispatch(
        configUpdate(this.resolveConfigPayload(configChanged)),
      );
      this.afterConfigDispatch(configChanged);
    }
    if (activeToolNames !== undefined) {
      this.setActiveTools(activeToolNames);
    }
  }

  applyBindingSnapshot(snapshot: ProfileBindingSnapshot): void {
    this.activeProfile = undefined;
    this.activeToolNamesOverlay = undefined;
    const agentsMdPaths =
      snapshot.agentsMdPaths ??
      extractAgentsMdPathsFromSystemPrompt(snapshot.systemPrompt);
    this.wire.dispatch(
      profileBind({
        modelAlias: snapshot.modelAlias,
        profileName: snapshot.profileName,
        thinkingEffort: snapshot.thinkingLevel,
        systemPrompt: snapshot.systemPrompt,
        environmentDisclosure: snapshot.environmentDisclosure,
        renderGeneration: snapshot.renderGeneration,
        agentsMdPaths,
        activeToolNames: snapshot.activeToolNames,
        disallowedTools: snapshot.disallowedTools ?? [],
        subagents: snapshot.subagents,
      }),
    );
    this.afterConfigDispatch({
      modelAlias: snapshot.modelAlias,
      profileName: snapshot.profileName,
      thinkingLevel: snapshot.thinkingLevel,
      systemPrompt: snapshot.systemPrompt,
      environmentDisclosure: snapshot.environmentDisclosure,
      agentsMdPaths,
      disallowedTools: snapshot.disallowedTools ?? [],
    });
    this.agentsMdReminder.seedInjected(agentsMdPaths, this.sessionContext.cwd);
  }

  async bind(input: BindAgentInput): Promise<void> {
    await this.catalog.ready;
    await this.identity.resolved();
    this.assertBindable(input.profile);
    const profile = this.catalog.get(input.profile);
    if (profile === undefined) {
      const available = this.catalog
        .list()
        .map((p) => p.name)
        .join(", ");
      throw new ProfileError(
        ProfileErrors.codes.PROFILE_UNKNOWN,
        `Unknown agent profile: "${input.profile}". Available profiles: ${available}`,
        { profile: input.profile, available },
      );
    }
    const alias = input.model ?? this.config.get<string>("defaultModel");
    if (alias === undefined || alias === "") {
      throw new ProfileError(
        ProfileErrors.codes.MODEL_NOT_CONFIGURED,
        `model is required to bind profile "${input.profile}" (no default model configured)`,
      );
    }
    const model = this.modelCatalog.get(alias);

    if (input.strictThinking === true && input.thinking !== undefined) {
      this.assertThinkingEffortSupported(input.thinking, model, alias);
    }

    await this.sessionToolPolicy.ready;
    const context = await this.buildSystemPromptContext(profile);
    this.assertBindable(profile.name);
    const currentProfileName = this.profileName;
    const rendered = profile.renderSystemPrompt(context);
    this.activeProfile = profile;
    this.cacheAgentsMdWarning(context);

    const thinkingLevel = this.resolveThinkingEffort(
      input.thinking ??
        (currentProfileName !== undefined ? this.thinkingLevel : undefined),
      model,
    );

    this.activeToolNamesOverlay = undefined;
    this.wire.dispatch(
      profileBind({
        modelAlias: alias,
        profileName: profile.name,
        thinkingEffort: thinkingLevel,
        systemPrompt: rendered.text,
        environmentDisclosure: rendered.environment,
        agentsMdPaths: context.agentsMdPaths ?? [],
        activeToolNames: profile.tools,
        disallowedTools: profile.disallowedTools ?? [],
        subagents: profile.subagents,
      }),
    );
    this.afterConfigDispatch({
      modelAlias: alias,
      profileName: profile.name,
      thinkingLevel,
      systemPrompt: rendered.text,
      disallowedTools: profile.disallowedTools ?? [],
    });
    this.seedAgentsMdReminder(context);

    this.publishAgentsMdWarning();
    this.publishToolPatternWarnings(profile);
  }

  async setModel(alias: string): Promise<ProfileSetModelResult> {
    const model = this.modelCatalog.get(alias);
    if (this.profileName === undefined) {
      await this.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: alias });
    } else if (this.modelAlias !== alias) {
      this.update({ modelAlias: alias });
    }
    return {
      model: alias,
      providerName: model.providerName,
    };
  }

  setThinking(level: string): void {
    const previousEffort = this.thinkingLevel;
    this.assertThinkingEffortSupported(
      level,
      this.tryResolveRawModel(),
      this.modelAlias ?? "",
    );
    const normalized = normalizeRequestedThinkingEffort(level);
    this.update({ thinkingLevel: normalized ?? level });
    const effort = this.thinkingLevel;
    if (effort !== previousEffort) {
    }
  }

  private assertThinkingEffortSupported(
    requested: string,
    model: Model | undefined,
    modelAlias: string,
  ): void {
    const normalized = normalizeRequestedThinkingEffort(requested);
    if (
      normalized === undefined ||
      this.supportsThinkingEffort(normalized, model)
    )
      return;
    const efforts = model?.supportEfforts ?? [];
    const supported =
      efforts.length === 0 ? "off" : ["off", ...efforts].join(", ");
    throw new ProfileError(
      ProfileErrors.codes.MODEL_CONFIG_INVALID,
      `Thinking effort "${requested}" is not supported by model "${modelAlias}". Supported efforts: ${supported}.`,
    );
  }

  getModel(): string {
    return this.modelAlias ?? "";
  }

  useProfile(
    profile: ResolvedAgentProfile,
    context: SystemPromptContext,
  ): void {
    this.activeProfile = profile;
    const rendered = profile.renderSystemPrompt(context);
    this.update({
      profileName: profile.name,
      systemPrompt: rendered.text,
      environmentDisclosure: rendered.environment,
      agentsMdPaths: context.agentsMdPaths ?? [],
      disallowedTools: profile.disallowedTools ?? [],
    });
    this.setActiveTools(profile.tools);
  }

  async applyProfile(
    profile: ResolvedAgentProfile,
    options?: ApplyProfileOptions,
  ): Promise<void> {
    const context = await this.buildSystemPromptContext(profile, options);
    this.useProfile(profile, context);
    this.seedAgentsMdReminder(context);
    this.cacheAgentsMdWarning(context);
    this.publishAgentsMdWarning();
    this.publishToolPatternWarnings(profile);
  }

  async refreshSystemPrompt(): Promise<void> {
    const profile = this.resolveActiveProfile();
    if (profile === undefined) return;

    let context: SystemPromptContext;
    try {
      context = await this.buildSystemPromptContext(profile);
    } catch (error) {
      this.eventBus.publish({
        type: "warning",
        message: `System prompt refresh skipped: ${error instanceof Error ? error.message : String(error)}`,
        code: "system-prompt-refresh-failed",
      });
      return;
    }
    this.activeProfile = profile;
    const rendered = profile.renderSystemPrompt(context);
    this.update({
      profileName: profile.name,
      systemPrompt: rendered.text,
      environmentDisclosure: rendered.environment,
      agentsMdPaths: context.agentsMdPaths ?? [],
    });
    this.seedAgentsMdReminder(context);
    this.cacheAgentsMdWarning(context);
    this.publishAgentsMdWarning();
  }
}
