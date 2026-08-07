import {
  type KimiConfig,
  type ModelAlias,
  type ThinkingEffort,
} from "@moonshot-ai/kimi-code-sdk";

import { EffortSelectorComponent } from "../components/dialogs/effort-selector";
import {
  modelDisplayName,
  segmentsFor,
} from "../components/dialogs/model-selector";
import { TabbedModelSelectorComponent } from "../components/dialogs/tabbed-model-selector";
import { formatErrorMessage } from "../utils/event-payload";
import type { SlashCommandHost } from "./dispatch";
import {
  EFFORT_SWITCH_CACHE_WARNING,
  effectiveModelForHost,
  hasConversationHistory,
  MODEL_PICKER_REFRESH_TIMEOUT_MS,
  MODEL_SWITCH_CACHE_WARNING,
  persistModelSelection,
  pickerModelsForHost,
  withTimeout,
} from "./config-shared";

export async function handleModelCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  if (alias.length === 0) {
    showModelPicker(host);
    return;
  }
  if (host.state.appState.availableModels[alias] === undefined) {
    host.showError(`Unknown model alias: ${alias}`);
    return;
  }
  showModelPicker(host, alias);
}

export async function handleSecondaryModelCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  const models = pickerModelsForHost(host);
  if (Object.keys(models).length === 0) {
    host.showNotice(
      "No models configured",
      "Run /login to sign in to Kimi, or /provider to add another provider from a model catalog.",
    );
    return;
  }
  if (alias.length > 0 && models[alias] === undefined) {
    host.showError(`Unknown model alias: ${alias}`);
    return;
  }
  const secondary = (await host.harness.getConfig()).secondaryModel;
  showSecondaryModelPicker(
    host,
    models,
    secondary?.model ?? "",
    secondary?.defaultEffort,
    alias,
  );
}

export async function handleEffortCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const alias = host.state.appState.model;
  const model = host.state.appState.availableModels[alias];
  if (model === undefined) {
    host.showError("No model selected. Run /model to select one first.");
    return;
  }
  const effective = effectiveModelForHost(host, model);
  const segments = segmentsFor(effective);
  const arg = args.trim().toLowerCase();
  if (arg.length === 0) {
    showEffortPicker(host, effective, segments);
    return;
  }
  if (!segments.includes(arg)) {
    const providerType =
      host.state.appState.availableProviders[effective.provider]?.type;
    const protocol = effective.protocol ?? providerType;
    if (protocol !== "anthropic") {
      host.showError(
        `Unsupported thinking effort "${arg}" for ${alias}. Available: ${segments.join(", ")}`,
      );
      return;
    }
    const knownEfforts =
      effective.supportEfforts?.join(", ") ?? "none declared";
    host.showStatus(
      `Thinking effort "${arg}" is not listed for ${alias} (known: ${knownEfforts}). Sending "${arg}" unchanged; the configured provider will validate it.`,
      "warning",
    );
  }
  await performModelSwitch(host, alias, arg, true);
}

function showEffortPicker(
  host: SlashCommandHost,
  model: ModelAlias,
  segments: readonly string[],
): void {
  const liveEffort = host.state.appState.thinkingEffort;
  const currentValue = segments.includes(liveEffort)
    ? liveEffort
    : (segments[0] ?? "off");
  const alias = host.state.appState.model;
  host.mountEditorReplacement(
    new EffortSelectorComponent({
      efforts: segments,
      currentValue,
      warning: hasConversationHistory(host)
        ? EFFORT_SWITCH_CACHE_WARNING
        : undefined,
      onSelect: (effort) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, effort, true);
      },
      onSessionOnlySelect: (effort) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, effort, false);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function refreshModelsForPicker(host: SlashCommandHost): Promise<void> {
  try {
    const result = await withTimeout(
      host.authFlow.refreshOAuthProviderModels(),
      MODEL_PICKER_REFRESH_TIMEOUT_MS,
    );
    if (result === undefined) return;
    for (const f of result.failed) {
      host.showStatus(
        `Skipped refreshing ${f.provider}: ${f.reason}`,
        "warning",
      );
    }
  } catch (error) {
    host.showStatus(
      `Skipped refreshing models: ${formatErrorMessage(error)}`,
      "warning",
    );
  }
}

export function showModelPicker(
  host: SlashCommandHost,
  selectedValue: string = host.state.appState.model,
): void {
  const models = pickerModelsForHost(host);
  const entries = Object.entries(models);
  if (entries.length === 0) {
    host.showNotice(
      "No models configured",
      "Run /login to sign in to Kimi, or /provider to add another provider from a model catalog.",
    );
    return;
  }
  host.mountEditorReplacement(
    new TabbedModelSelectorComponent({
      models,
      currentValue: host.state.appState.model,
      selectedValue,
      currentThinkingEffort: host.state.appState.thinkingEffort,
      warning: hasConversationHistory(host)
        ? MODEL_SWITCH_CACHE_WARNING
        : undefined,
      onSelect: ({ alias, thinking }) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, thinking, true);
      },
      onSessionOnlySelect: ({ alias, thinking }) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, thinking, false);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function performModelSwitch(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
  persist: boolean,
): Promise<void> {
  let session = host.session;
  if (session === undefined && host.engineV2) {
    // A first prompt may still be inside lazy creation: wait it out so the
    // switch lands on the new session instead of being overwritten by its
    // assembly.
    await host.waitForLazyCreation();
    session = host.session;
  }
  if (host.state.appState.streamingPhase !== "idle") {
    host.showError(
      "Cannot switch models while streaming — press Esc or Ctrl-C first.",
    );
    return;
  }

  const prevModel = host.state.appState.model;
  const prevEffort = host.state.appState.thinkingEffort;
  const modelChanged = alias !== prevModel;
  const effortChanged = effort !== prevEffort;
  const runtimeChanged = modelChanged || effortChanged;
  let effectiveAlias = alias;
  let effectiveEffort = effort;

  try {
    if (session === undefined && runtimeChanged) {
      await host.authFlow.activateModelAfterLogin(alias, effort);
    } else if (session !== undefined) {
      if (alias !== prevModel) {
        await session.setModel(alias);
      }
      if (effort !== prevEffort) {
        await session.setThinking(effort);
      }
      const status = await session.getStatus();
      effectiveAlias = status.model ?? alias;
      effectiveEffort = status.thinkingEffort;
    }
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to switch model: ${msg}`);
    return;
  }

  if (session === undefined) {
    effectiveAlias = host.state.appState.model;
    effectiveEffort = host.state.appState.thinkingEffort;
  }
  const effectiveModelChanged = effectiveAlias !== prevModel;
  const effectiveEffortChanged = effectiveEffort !== prevEffort;
  const displayName = modelDisplayName(
    effectiveAlias,
    host.state.appState.availableModels[effectiveAlias],
  );
  host.setAppState({ model: effectiveAlias, thinkingEffort: effectiveEffort });
  if (session === undefined && runtimeChanged) {
    if (effectiveModelChanged) {
      host.track("model_switch", { model: effectiveAlias });
    }
    if (effectiveEffortChanged) {
      host.track("thinking_toggle", {
        enabled: effectiveEffort !== "off",
        effort: effectiveEffort,
        from: prevEffort,
      });
    }
  }

  let persisted = false;
  if (persist) {
    try {
      persisted = await persistModelSelection(
        host,
        effectiveAlias,
        effectiveEffort,
        effectiveEffortChanged,
      );
    } catch (error) {
      const msg = formatErrorMessage(error);
      host.showError(
        `Switched to ${displayName}, but failed to save default: ${msg}`,
      );
      return;
    }
  }

  let status: string;
  if (effectiveModelChanged) {
    status = persist
      ? `Switched to ${displayName} with thinking ${effectiveEffort}.`
      : `Switched to ${displayName} with thinking ${effectiveEffort} for this session only.`;
  } else if (effectiveEffortChanged) {
    status = persist
      ? `Thinking set to ${effectiveEffort}.`
      : `Thinking set to ${effectiveEffort} for this session only.`;
  } else if (persist && persisted) {
    status = `Saved ${displayName} with thinking ${effectiveEffort} as default.`;
  } else {
    status = `Already using ${displayName} with thinking ${effectiveEffort}.`;
  }
  host.showStatus(status, "success");
}

function showSecondaryModelPicker(
  host: SlashCommandHost,
  models: Record<string, ModelAlias>,
  currentValue: string,
  currentEffort: string | undefined,
  selectedValue?: string,
): void {
  host.mountEditorReplacement(
    new TabbedModelSelectorComponent({
      models,
      currentValue,
      selectedValue,
      currentThinkingEffort: currentEffort ?? "off",
      title: " Select a secondary model (subagents)",
      onSelect: ({ alias, thinking }) => {
        host.restoreEditor();
        void performSecondaryModelSwitch(host, alias, thinking);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

/**
 * Persist-first, then live-apply: the synthesized derived entry only exists in
 * the core config after a reload. No session-only variant — a session-local
 * recipe with patch fields would bind a derived alias the core config cannot
 * resolve.
 */
async function performSecondaryModelSwitch(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
): Promise<void> {
  const displayName = modelDisplayName(
    alias,
    host.state.appState.availableModels[alias],
  );
  let updatedConfig: KimiConfig;
  try {
    updatedConfig = await host.harness.setConfig({
      secondaryModel: { model: alias, defaultEffort: effort },
    });
  } catch (error) {
    host.showError(
      `Failed to save secondary model: ${formatErrorMessage(error)}`,
    );
    return;
  }
  if (host.session !== undefined) {
    try {
      await host.session.applyPersistedSecondaryModel();
    } catch (error) {
      host.showError(
        `Saved ${displayName} as the secondary model, but failed to apply it to this session: ${formatErrorMessage(error)}`,
      );
      return;
    }
  }
  host.setAppState({ availableModels: updatedConfig.models ?? {} });
  // Report the effective binding from the reloaded config, not the picked
  // value: KIMI_SECONDARY_MODEL / KIMI_SECONDARY_EFFORT override the recipe at
  // runtime, and the session binds the overlaid snapshot (mirrors how
  // /model displays the effective alias read back from the session).
  const effective = updatedConfig.secondaryModel;
  const envOverrides: string[] = [];
  if (effective?.model !== undefined && effective.model !== alias) {
    envOverrides.push(`KIMI_SECONDARY_MODEL=${effective.model}`);
  }
  if (
    effective?.defaultEffort !== undefined &&
    effective.defaultEffort !== effort
  ) {
    envOverrides.push(`KIMI_SECONDARY_EFFORT=${effective.defaultEffort}`);
  }
  if (envOverrides.length > 0 && effective?.model !== undefined) {
    const effectiveName = modelDisplayName(
      effective.model,
      updatedConfig.models?.[effective.model],
    );
    host.showStatus(
      `Saved ${displayName} as the secondary model, but ${envOverrides.join(" and ")} ` +
        `overrides it at runtime — subagents bind ${effectiveName} until the env var is unset.`,
      "warning",
    );
    return;
  }
  host.showStatus(
    host.session === undefined
      ? `Secondary model set to ${displayName} with thinking ${effort}; applies to new sessions.`
      : `Secondary model set to ${displayName} with thinking ${effort}.`,
    "success",
  );
}
