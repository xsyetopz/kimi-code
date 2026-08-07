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

import { AgentProfileServiceCore } from "./profileService.core";

export class AgentProfileService extends AgentProfileServiceCore {
  private seedAgentsMdReminder(context: SystemPromptContext): void {
    this.agentsMdReminder.seedInjected(
      context.agentsMdPaths ?? [],
      context.cwd ?? this.sessionContext.cwd,
    );
  }

  getAgentsMdWarning(): string | undefined {
    return this.agentsMdWarning;
  }

  data(): ProfileData {
    const model = this.tryResolveRawModel();
    return {
      modelAlias: this.modelAlias,
      modelCapabilities: model?.capabilities ?? UNKNOWN_CAPABILITY,
      profileName: this.profileName,
      thinkingLevel: this.thinkingLevel,
      systemPrompt: this.systemPrompt,
      agentsMdPaths: this.profileState.agentsMdPaths,
      activeToolNames:
        this.activeToolNames === undefined
          ? undefined
          : [...this.activeToolNames],
      disallowedTools: [...(this.profileState.disallowedTools ?? [])],
      subagents:
        this.profileState.subagents === undefined
          ? undefined
          : [...this.profileState.subagents],
      environmentDisclosure: this.profileState.environmentDisclosure,
      renderGeneration: this.profileState.renderGeneration,
    };
  }

  getEffectiveThinkingLevel(): ThinkingEffort {
    return this.resolveThinkingState(this.tryResolveRawModel()).effective;
  }

  resolveModelContext(): ProfileModelContext {
    const modelAlias = this.model;
    const model = this.modelCatalog.get(modelAlias);
    const loopControl = this.config.get<LoopControl>("loopControl");
    return {
      modelAlias,
      modelCapabilities: model.capabilities,
      maxOutputSize: model.maxOutputSize,
      alwaysThinking: model.alwaysThinking || undefined,
      thinkingLevel: this.resolveThinkingState(model).effective,
      reservedContextSize: loopControl?.reservedContextSize,
      compactionTriggerRatio: loopControl?.compactionTriggerRatio,
    };
  }

  resolveRequestParams(): ModelRequestParams {
    const model = this.tryResolveRawModel();
    const thinking = this.resolveThinkingState(model);
    const thinkingConfig = this.config.get<ThinkingConfig>(THINKING_SECTION);
    const overrides = this.config.get<ModelOverrides>("modelOverrides");
    const sampling: SamplingOptions = {
      temperature: overrides?.temperature,
      topP: overrides?.topP,
    };
    return {
      cacheKey: this.sessionContext.sessionId,
      sampling:
        sampling.temperature === undefined && sampling.topP === undefined
          ? undefined
          : sampling,
      thinkingEffort: thinking.effective,
      thinkingKeep: resolveThinkingKeep(
        overrides?.thinkingKeep,
        thinkingConfig?.keep,
        thinking.effective,
      ),
    };
  }

  getModelCapabilities(): ModelCapability {
    return this.tryResolveRawModel()?.capabilities ?? UNKNOWN_CAPABILITY;
  }

  getMaxOutputSize(): number | undefined {
    return this.tryResolveRawModel()?.maxOutputSize;
  }

  hasModel(): boolean {
    return this.modelAlias !== undefined;
  }

  isRunnable(): boolean {
    return this.profileName !== undefined && this.hasModel();
  }

  hasProvider(): boolean {
    return this.tryResolveRawModel() !== undefined;
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  getActiveToolNames(): readonly string[] | undefined {
    return this.activeToolNames;
  }

  addActiveTool(name: string): void {
    const activeToolNames = this.activeToolNames;
    if (activeToolNames === undefined || activeToolNames.includes(name)) return;
    this.activeToolNamesOverlay = [...activeToolNames, name];
  }

  removeActiveTool(name: string): void {
    const activeToolNames = this.activeToolNames;
    if (activeToolNames === undefined || !activeToolNames.includes(name))
      return;
    this.activeToolNamesOverlay = activeToolNames.filter(
      (candidate) => candidate !== name,
    );
  }

  private resolveConfigPayload(
    changed: Omit<ProfileUpdateData, "activeToolNames">,
  ): PayloadOf<typeof configUpdate> {
    const payload: {
      -readonly [K in keyof PayloadOf<typeof configUpdate>]: PayloadOf<
        typeof configUpdate
      >[K];
    } = {};
    if (changed.modelAlias !== undefined)
      payload.modelAlias = changed.modelAlias;
    if (changed.profileName !== undefined)
      payload.profileName = changed.profileName;
    if (
      changed.thinkingLevel !== undefined ||
      changed.modelAlias !== undefined
    ) {
      const model = this.resolveModelForThinking(
        changed.modelAlias ?? this.modelAlias,
      );
      const requested =
        changed.thinkingLevel ??
        (this.modelAlias === undefined ? undefined : this.thinkingLevel);
      payload.thinkingEffort = this.resolveThinkingEffort(requested, model);
    }
    if (changed.systemPrompt !== undefined) {
      payload.systemPrompt = changed.systemPrompt;
      if (changed.environmentDisclosure !== undefined) {
        payload.environmentDisclosure = changed.environmentDisclosure;
      }
    }
    if (changed.agentsMdPaths !== undefined) {
      payload.agentsMdPaths = [...changed.agentsMdPaths];
    }
    if (changed.disallowedTools !== undefined) {
      payload.disallowedTools = [...changed.disallowedTools];
    }
    return payload;
  }

  private afterConfigDispatch(
    changed: Omit<ProfileUpdateData, "activeToolNames">,
  ): void {
    if (changed.modelAlias !== undefined) {
      const model = this.tryResolveRawModel();
    }
    if (
      changed.modelAlias !== undefined ||
      changed.thinkingLevel !== undefined
    ) {
      this.warnAboutAnthropicThinkingEffort();
    }
    this.emitStatusUpdated(
      changed.modelAlias !== undefined || changed.thinkingLevel !== undefined,
    );
  }

  private warnAboutAnthropicThinkingEffort(): void {
    try {
      const model = this.tryResolveRawModel();
      if (model?.protocol !== "anthropic") return;
      const effort = this.getEffectiveThinkingLevel();
      if (effort === "on" || effort === "off") return;

      let code: string;
      let message: string;
      let knownEfforts = "";
      const efforts = model.supportEfforts?.filter((value) => value.length > 0);
      if (
        efforts === undefined ||
        efforts.length === 0 ||
        efforts.includes(effort)
      )
        return;
      knownEfforts = efforts.join(",");
      code = "anthropic-thinking-effort-not-listed";
      message = `Thinking effort "${effort}" is not listed for model "${model.name}" (known: ${efforts.join(", ")}). The configured value will be sent unchanged to the Anthropic-compatible backend.`;

      const key = [code, model.id, model.name, effort, knownEfforts].join(
        "\u0000",
      );
      if (this.emittedThinkingEffortWarnings.has(key)) return;
      this.emittedThinkingEffortWarnings.add(key);
      this.eventBus.publish({ type: "warning", code, message });
    } catch {}
  }

  private setActiveTools(names: readonly string[] | undefined): void {
    this.activeToolNamesOverlay = undefined;
    if (names === undefined) {
      this.wire.dispatch(resetActiveTools({}));
      return;
    }
    this.wire.dispatch(setActiveTools({ names: [...names] }));
  }

  private emitStatusUpdated(includeThinkingEffort = false): void {
    const custom = this.optionsValue.emitStatusUpdated;
    if (custom !== undefined) {
      custom();
      return;
    }
    if (!this.hasModel()) return;
    // An alias that no longer resolves (e.g. the model entry was removed from
    // config) yields UNKNOWN_CAPABILITY whose max_context_tokens is 0 — the
    // "unknown" marker, not a real limit. Omit the field instead of pushing 0.
    const capabilities = this.tryResolveRawModel()?.capabilities;
    const maxContextTokens =
      capabilities?.max_input_tokens ?? capabilities?.max_context_tokens;
    this.eventBus.publish({
      type: "agent.status.updated",
      model: this.modelAlias,
      thinkingEffort: includeThinkingEffort
        ? this.getEffectiveThinkingLevel()
        : undefined,
      maxContextTokens:
        maxContextTokens !== undefined && maxContextTokens > 0
          ? maxContextTokens
          : undefined,
    });
  }

  republishStatus(): void {
    this.emitStatusUpdated(true);
  }

  private get profileState(): ProfileModelState {
    return this.wire.getModel(ProfileModel);
  }

  private get model(): string {
    const modelAlias = this.modelAlias;
    if (modelAlias === undefined) {
      throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, "Model not set");
    }
    return modelAlias;
  }

  private get modelAlias(): string | undefined {
    return this.profileState.modelAlias;
  }

  private get profileName(): string | undefined {
    return this.profileState.profileName;
  }

  private get systemPrompt(): string {
    return this.profileState.systemPrompt;
  }

  private get thinkingLevel(): ThinkingEffort {
    const stored = this.profileState.thinkingLevel;
    if (stored === "off" && this.alwaysThinkingModel) {
      return this.resolveThinkingEffort(stored, this.tryResolveRawModel());
    }
    return stored;
  }

  private resolveThinkingState(model: Model | undefined): {
    readonly effective: ThinkingEffort;
    readonly forced: ThinkingEffort | undefined;
  } {
    const base = this.thinkingLevel;
    const forced = resolveForcedThinkingEffort(
      this.config.get<ThinkingConfig>(THINKING_SECTION)?.forcedEffort,
      base,
      drivesThinkingThroughTraits(model?.providerType),
    );
    return { effective: forced ?? base, forced };
  }

  private strictThinkingValidation(model: Model | undefined): boolean {
    if (model === undefined) return false;
    return requiresStrictThinkingValidation(
      this.protocolAdapters,
      model.protocol,
      model.providerType,
    );
  }

  private resolveThinkingEffort(
    requested: string | undefined,
    model: Model | undefined,
  ): ThinkingEffort {
    return resolveThinkingEffortForModel(
      requested,
      this.config.get<ThinkingConfig>(THINKING_SECTION),
      model,
      this.strictThinkingValidation(model),
    );
  }

  private supportsThinkingEffort(
    effort: ThinkingEffort,
    model: Model | undefined,
  ): boolean {
    return modelSupportsThinkingEffort(
      effort,
      model,
      this.strictThinkingValidation(model),
    );
  }

  private get alwaysThinkingModel(): boolean {
    return this.tryResolveRawModel()?.alwaysThinking === true;
  }

  private tryResolveRawModel(): Model | undefined {
    const alias = this.modelAlias;
    return this.resolveModelForThinking(alias);
  }

  private resolveModelForThinking(
    alias: string | undefined,
  ): Model | undefined {
    if (alias === undefined) return undefined;
    try {
      return this.modelCatalog.get(alias);
    } catch {
      return undefined;
    }
  }

  private assertBindable(requested: string): void {
    const current = this.profileName;
    if (current !== undefined && current !== requested) {
      throw new ProfileError(
        ProfileErrors.codes.PROFILE_ALREADY_BOUND,
        `agent is already bound to profile "${current}"; cannot switch to "${requested}" in this session`,
        { current, requested },
      );
    }
  }

  private resolveActiveProfile(): ResolvedAgentProfile | undefined {
    if (this.activeProfile !== undefined) return this.activeProfile;
    const profileName = this.profileName;
    if (profileName === undefined) return undefined;
    return this.catalog.get(profileName);
  }

  private cacheAgentsMdWarning(
    context: Pick<SystemPromptContext, "agentsMdWarning">,
  ): void {
    this.agentsMdWarning = context.agentsMdWarning;
  }

  private publishAgentsMdWarning(): void {
    const warning = this.agentsMdWarning;
    if (warning === undefined) return;
    this.eventBus.publish({
      type: "warning",
      message: warning,
      code: "agents-md-oversized",
    });
  }

  private publishToolPatternWarnings(profile?: ResolvedAgentProfile): void {
    const known = new Set<string>();
    for (const contribution of getAgentToolContributions())
      known.add(contribution.options.name);
    for (const ref of this.toolRegistry.listReferences()) known.add(ref.name);
    for (const builtin of this.builtinProfiles.list()) {
      for (const name of literalToolNames([
        ...(builtin.tools ?? []),
        ...(builtin.disallowedTools ?? []),
      ])) {
        known.add(name);
      }
    }
    const checks: {
      context: string;
      field: string;
      patterns: readonly string[] | undefined;
    }[] = [];
    if (profile !== undefined) {
      checks.push(
        {
          context: `profile "${profile.name}"`,
          field: "tools",
          patterns: profile.tools,
        },
        {
          context: `profile "${profile.name}"`,
          field: "disallowedTools",
          patterns: profile.disallowedTools,
        },
      );
    }
    const global = this.config.get<ToolsConfig>(TOOLS_SECTION);
    checks.push(
      {
        context: "the global [tools] config",
        field: "enabled",
        patterns: global?.enabled,
      },
      {
        context: "the global [tools] config",
        field: "disabled",
        patterns: global?.disabled,
      },
    );
    for (const { context, field, patterns } of checks) {
      if (patterns === undefined) continue;
      for (const issue of findInactiveToolPatterns(patterns, (name) =>
        known.has(name),
      )) {
        const key = `${context}|${field}|${issue.pattern}`;
        if (this.emittedToolPatternWarnings.has(key)) continue;
        this.emittedToolPatternWarnings.add(key);
        this.eventBus.publish({
          type: "warning",
          code: "tool-pattern-no-match",
          message: describeInactiveToolPattern(context, field, issue),
        });
      }
    }
  }

  private async buildSystemPromptContext(
    profile: ResolvedAgentProfile,
    options?: ApplyProfileOptions,
  ): Promise<SystemPromptContext> {
    const preloadedAgentsMd = await this.workspaceInstructionsSnapshot();
    const base = await prepareSystemPromptContext(
      { fs: this.fs, homeDir: this.env.homeDir },
      this.sessionContext.cwd,
      this.bootstrap.homeDir,
      {
        additionalDirs:
          options?.additionalDirs ?? this.workspace.additionalDirs,
        preloadedAgentsMd,
      },
    );
    const skills = await this.resolveSkillListing();
    const pluginSections = await this.resolvePluginSections();
    const now = this.clock.now();
    const timeZone = this.clock.timeZone();
    return {
      ...base,
      cwd: this.sessionContext.cwd,
      osKind: this.env.osKind,
      shellName: this.env.shellName,
      shellPath: this.env.shellPath,
      now: now.toISOString(),
      timeZone,
      skills,
      pluginSections,
      skillActive: this.isToolActiveForProfile(profile, "Skill"),
      productName: (await this.identity.resolved()).displayName,
      replyStyleGuide: this.bootstrap.args.replyStyleGuide,
    };
  }

  private async workspaceInstructionsSnapshot(): Promise<LoadedAgentsMd> {
    await this.instructions.ready;
    return {
      content: this.instructions.agentsMd ?? "",
      warning: this.instructions.agentsMdWarning,
      paths: this.instructions.agentsMdPaths ?? [],
    };
  }

  private isToolActiveForProfile(
    profile: ResolvedAgentProfile,
    name: string,
    source: ToolSource = "builtin",
  ): boolean {
    return isToolActiveComposed(
      {
        workspaceDisabledTools: this.toolPolicyGate.disabledTools,
        profile,
        global: this.config.get<ToolsConfig>(TOOLS_SECTION),
        sessionDisabledTools: this.sessionToolPolicy.disabledTools(),
      },
      name,
      source,
    );
  }

  private async resolveSkillListing(): Promise<string> {
    try {
      await this.skillCatalog.ready;
      return this.skillCatalog.catalog.getModelSkillListing();
    } catch {
      return "";
    }
  }

  private async resolvePluginSections(): Promise<string> {
    const sections = await this.plugins.enabledSystemPrompts();
    const parts: string[] = [];
    const skipped: string[] = [];
    let totalBytes = 0;
    for (const section of sections) {
      const block = `<!-- From: plugin ${section.pluginId} -->\n${section.content}`;
      const bytes = Buffer.byteLength(block, "utf8");
      if (totalBytes + bytes > PLUGIN_SECTIONS_MAX_BYTES) {
        skipped.push(section.pluginId);
        continue;
      }
      totalBytes += bytes;
      parts.push(block);
    }
    if (skipped.length > 0) {
      const newlySkipped = skipped.filter(
        (id) => !this.emittedPluginBudgetWarnings.has(id),
      );
      if (newlySkipped.length > 0) {
        for (const id of newlySkipped) this.emittedPluginBudgetWarnings.add(id);
        this.eventBus.publish({
          type: "warning",
          message:
            `Plugin system-prompt contributions from ${newlySkipped.map((id) => `"${id}"`).join(", ")} ` +
            `were skipped: the aggregate ${PLUGIN_SECTIONS_MAX_BYTES / 1024} KB budget is exhausted.`,
          code: "plugin-sections-oversized",
        });
      }
    }
    return parts.join("\n\n");
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentProfileService,
  AgentProfileService,
  ScopeActivation.OnScopeCreated,
  "profile",
);
