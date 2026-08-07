import {
  effectiveModelAlias,
  SECONDARY_DERIVED_MODEL_ALIAS,
  type ModelAlias,
  type ThinkingEffort,
} from "@moonshot-ai/kimi-code-sdk";

import { DEFAULT_TUI_CONFIG, type TuiConfig } from "../config";
import { thinkingEffortToConfig } from "../utils/thinking-config";
import type { SlashCommandHost } from "./dispatch";

export const MODEL_PICKER_REFRESH_TIMEOUT_MS = 2_000;

export const MODEL_SWITCH_CACHE_WARNING =
  "Note: Switching models invalidates the existing prompt cache. Use /new to avoid extra token costs.";
export const EFFORT_SWITCH_CACHE_WARNING =
  "Note: Switching effort invalidates the existing prompt cache. Use /new to avoid extra token costs.";

/** True once the conversation has at least one user message: a switch from
 * then on resends the accumulated context, losing the cache. Shell-command
 * echoes are also 'user' transcript entries but carry an empty `bullet`, so
 * they're excluded. */
export function hasConversationHistory(host: SlashCommandHost): boolean {
  return host.state.transcriptEntries.some(
    (entry) => entry.kind === "user" && entry.bullet !== "",
  );
}

export function currentTuiConfig(host: SlashCommandHost): TuiConfig {
  return {
    theme: host.state.appState.theme,
    editorCommand: host.state.appState.editorCommand,
    disablePasteBurst:
      host.state.appState.disablePasteBurst ??
      DEFAULT_TUI_CONFIG.disablePasteBurst,
    notifications: host.state.appState.notifications,
    upgrade: host.state.appState.upgrade,
  };
}

export function effectiveModelForHost(
  host: SlashCommandHost,
  model: ModelAlias,
): ModelAlias {
  const providerType =
    host.state.appState.availableProviders[model.provider]?.type;
  // Flat models (no named provider, e.g. inline base_url served by a v2
  // backend) have no provider entry to look up; their own protocol declaration
  // plays the provider-identity role, mirroring the resolver.
  return effectiveModelAlias(model, providerType ?? model.protocol);
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function persistModelSelection(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
  effortChanged: boolean,
): Promise<boolean> {
  const config = await host.harness.getConfig({ reload: true });
  const model = host.state.appState.availableModels[alias];
  const full = thinkingEffortToConfig(
    effort,
    model === undefined
      ? undefined
      : effectiveModelForHost(host, model).supportEfforts,
  );
  // Re-confirming the effort shown when the picker opened is not an explicit
  // choice — persist the model but leave the stored effort preference alone.
  const patch = effortChanged ? full : { enabled: full.enabled };
  if (
    config.defaultModel === alias &&
    config.thinking?.enabled === patch.enabled &&
    (!effortChanged || config.thinking?.effort === patch.effort)
  ) {
    return false;
  }
  await host.harness.setConfig({
    defaultModel: alias,
    thinking: patch,
  });
  return true;
}

/**
 * The models a picker may offer: the user's configured aliases with
 * host-effective provider resolution applied, minus the synthesized
 * `__secondary__` derived entry — a runtime artifact of the `[secondary_model]`
 * recipe that must never be selectable as a primary or secondary model.
 */
export function pickerModelsForHost(
  host: SlashCommandHost,
): Record<string, ModelAlias> {
  return Object.fromEntries(
    Object.entries(host.state.appState.availableModels)
      .filter(([alias]) => alias !== SECONDARY_DERIVED_MODEL_ALIAS)
      .map(([alias, model]) => [alias, effectiveModelForHost(host, model)]),
  );
}
