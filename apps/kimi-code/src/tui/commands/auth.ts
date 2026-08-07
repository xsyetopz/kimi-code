import {
  applyOpenPlatformConfig,
  fetchOpenPlatformModels,
  filterModelsByPrefix,
  getOpenPlatformById,
  OpenPlatformApiError,
  type DeviceAuthorization,
  type ManagedKimiCodeModelInfo,
  type ManagedKimiConfigShape,
  type OpenPlatformDefinition,
} from "@moonshot-ai/kimi-code-oauth";
import {
  log,
  type EngineOAuthFlowSnapshot,
  type EngineOAuthFlowStart,
} from "@moonshot-ai/kimi-code-sdk";

import type { ChoiceOption } from "../components/dialogs/choice-picker";
import {
  EXTERNAL_OAUTH_PROVIDER_IDS,
  EXTERNAL_OAUTH_PROVIDER_LABELS,
} from "../components/dialogs/platform-selector";
import {
  DEFAULT_OAUTH_PROVIDER_NAME,
  PRODUCT_NAME,
} from "../constant/kimi-tui";
import { formatErrorMessage } from "../utils/event-payload";
import type { LoginProgressSpinnerHandle } from "../types";
import {
  promptApiKey,
  promptLogoutProviderSelection,
  promptModelSelectionForOpenPlatform,
  promptPlatformSelection,
} from "./prompts";
import type { SlashCommandHost } from "./dispatch";

const TERMINAL_OAUTH_FLOW_STATUSES = new Set<EngineOAuthFlowSnapshot["status"]>(
  ["authenticated", "denied", "expired", "cancelled"],
);

// ---------------------------------------------------------------------------
// Auth: login / logout
// ---------------------------------------------------------------------------

export async function handleLoginCommand(
  host: SlashCommandHost,
): Promise<void> {
  const platformId = await promptPlatformSelection(host);
  if (platformId === undefined) return;

  if (platformId === "kimi-code") {
    await handleKimiCodeOAuthLogin(host);
    return;
  }

  if (EXTERNAL_OAUTH_PROVIDER_IDS.has(platformId)) {
    await handleExternalOAuthLogin(host, platformId);
    return;
  }

  const platform = getOpenPlatformById(platformId);
  if (platform === undefined) return;
  await handleOpenPlatformLogin(host, platform);
}

async function handleKimiCodeOAuthLogin(host: SlashCommandHost): Promise<void> {
  const status = await host.harness.auth.status(DEFAULT_OAUTH_PROVIDER_NAME);
  const alreadyLoggedIn = status.providers.some(
    (provider) =>
      provider.providerName === DEFAULT_OAUTH_PROVIDER_NAME &&
      provider.hasToken,
  );

  let spinner: LoginProgressSpinnerHandle | undefined;
  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancelLogin;
  try {
    await host.harness.auth.login(DEFAULT_OAUTH_PROVIDER_NAME, {
      signal: controller.signal,
      onDeviceCode: (data) => {
        spinner = host.showLoginAuthorizationPrompt(data);
      },
    });
    spinner?.stop({ ok: true, label: "Logged in." });
    spinner = undefined;
    try {
      await host.authFlow.refreshConfigAfterLogin();
    } catch (refreshError) {
      const message = formatErrorMessage(refreshError);
      host.showError(
        `Authentication successful, but failed to refresh config: ${message}`,
      );
      return;
    }
    host.track("login", {
      provider: DEFAULT_OAUTH_PROVIDER_NAME,
      method: "oauth",
      already_logged_in: alreadyLoggedIn,
    });
    if (alreadyLoggedIn) {
      host.showStatus(
        "Already logged in. Model configuration refreshed.",
        "success",
      );
    }
  } catch (error) {
    const cancelled = controller.signal.aborted;
    spinner?.stop({
      ok: false,
      label: cancelled ? "Login cancelled." : "Login failed.",
    });
    spinner = undefined;
    if (cancelled) return;
    log.warn("login failed", {
      providerName: DEFAULT_OAUTH_PROVIDER_NAME,
      alreadyLoggedIn,
      sessionId: host.session?.id,
      error,
    });
    const message = formatErrorMessage(error);
    host.showError(`Login failed: ${message}`);
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }
}

async function handleExternalOAuthLogin(
  host: SlashCommandHost,
  providerId: string,
): Promise<void> {
  const providerLabel =
    EXTERNAL_OAUTH_PROVIDER_LABELS[providerId] ?? providerId;
  const status = await host.harness.engineAuth.status(providerId);
  const alreadyLoggedIn = status.loggedIn;

  let spinner: LoginProgressSpinnerHandle | undefined;
  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
    void host.harness.engineAuth.cancelLogin(providerId).catch(() => undefined);
  };
  host.cancelInFlight = cancelLogin;

  try {
    const start = await host.harness.engineAuth.startLogin(providerId);
    if (start.status === "authenticated") {
      spinner = host.showLoginProgressSpinner("Logged in.");
      spinner.stop({ ok: true, label: "Logged in." });
      spinner = undefined;
      await host.authFlow.refreshConfigAfterLogin();
      host.track("login", {
        provider: providerId,
        method: "oauth",
        already_logged_in: alreadyLoggedIn,
      });
      if (alreadyLoggedIn) {
        host.showStatus(
          `Already logged in to ${providerLabel}. Model configuration refreshed.`,
          "success",
        );
      } else {
        host.showStatus(`Logged in to ${providerLabel}.`, "success");
      }
      return;
    }

    spinner = host.showLoginAuthorizationPrompt(
      toDeviceAuthorization(start),
      `Sign in to ${providerLabel}`,
    );

    const flow = await waitForExternalOAuthFlow(host, providerId, start, {
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      spinner.stop({ ok: false, label: "Login cancelled." });
      spinner = undefined;
      return;
    }
    if (flow.status !== "authenticated") {
      const message =
        flow.error_message ??
        `Login ${flow.status === "expired" ? "expired" : "failed"}.`;
      throw new Error(message);
    }

    spinner.stop({ ok: true, label: "Logged in." });
    spinner = undefined;
    try {
      await host.authFlow.refreshConfigAfterLogin();
    } catch (refreshError) {
      const message = formatErrorMessage(refreshError);
      host.showError(
        `Authentication successful, but failed to refresh config: ${message}`,
      );
      return;
    }
    host.track("login", {
      provider: providerId,
      method: "oauth",
      already_logged_in: alreadyLoggedIn,
    });
    if (alreadyLoggedIn) {
      host.showStatus(
        `Already logged in to ${providerLabel}. Model configuration refreshed.`,
        "success",
      );
    } else {
      host.showStatus(`Logged in to ${providerLabel}.`, "success");
    }
  } catch (error) {
    const cancelled = controller.signal.aborted;
    spinner?.stop({
      ok: false,
      label: cancelled ? "Login cancelled." : "Login failed.",
    });
    spinner = undefined;
    if (cancelled) return;
    log.warn("external oauth login failed", {
      providerId,
      alreadyLoggedIn,
      sessionId: host.session?.id,
      error,
    });
    const message = formatErrorMessage(error);
    host.showError(`Login failed: ${message}`);
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }
}

function toDeviceAuthorization(
  start: Extract<EngineOAuthFlowStart, { status: "pending" }>,
): DeviceAuthorization {
  return {
    userCode: start.user_code,
    deviceCode: "",
    verificationUri: start.verification_uri,
    verificationUriComplete: start.verification_uri_complete,
    expiresIn: start.expires_in,
    interval: start.interval,
  };
}

async function waitForExternalOAuthFlow(
  host: SlashCommandHost,
  providerId: string,
  start: Extract<EngineOAuthFlowStart, { status: "pending" }>,
  options: { readonly signal: AbortSignal },
): Promise<EngineOAuthFlowSnapshot> {
  let intervalSec = start.interval;
  while (!options.signal.aborted) {
    await sleepMs(intervalSec * 1000, options.signal);
    if (options.signal.aborted) {
      return {
        flow_id: start.flow_id,
        provider: providerId,
        status: "cancelled",
        verification_uri: start.verification_uri,
        verification_uri_complete: start.verification_uri_complete,
        user_code: start.user_code,
        expires_in: start.expires_in,
        expires_at: start.expires_at,
        interval: start.interval,
      };
    }
    const flow = await host.harness.engineAuth.flow(providerId);
    if (flow === undefined) continue;
    if (TERMINAL_OAUTH_FLOW_STATUSES.has(flow.status)) return flow;
    if (flow.interval > intervalSec) intervalSec = flow.interval;
  }
  return {
    flow_id: start.flow_id,
    provider: providerId,
    status: "cancelled",
    verification_uri: start.verification_uri,
    verification_uri_complete: start.verification_uri_complete,
    user_code: start.user_code,
    expires_in: start.expires_in,
    expires_at: start.expires_at,
    interval: start.interval,
  };
}

function sleepMs(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function handleOpenPlatformLogin(
  host: SlashCommandHost,
  platform: OpenPlatformDefinition,
): Promise<void> {
  const consoleHost = platform.consoleUrl?.replace(/^https?:\/\//, "") ?? "";
  const platformName =
    consoleHost.length > 0 ? `Kimi Platform (${consoleHost})` : "Kimi Platform";
  const subtitleLines = [
    `${"base_url".padEnd(12)}${platform.baseUrl}`,
    `${"saved to".padEnd(12)}~/.kimi-code/config.toml`,
  ];
  const apiKey = await promptApiKey(host, platformName, subtitleLines);
  if (apiKey === undefined) return;

  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancelLogin;

  let models: ManagedKimiCodeModelInfo[];
  try {
    models = await fetchOpenPlatformModels(
      platform,
      apiKey,
      fetch,
      controller.signal,
    );
    models = filterModelsByPrefix(models, platform);
  } catch (error) {
    if (controller.signal.aborted) return;
    const msg = formatErrorMessage(error);
    host.showError(`Failed to verify API key: ${msg}`);
    if (error instanceof OpenPlatformApiError && error.status === 401) {
      host.showStatus(
        'Hint: If your API key was obtained from Kimi Code, please select "Kimi Code" instead.',
      );
    }
    return;
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }

  if (models.length === 0) {
    host.showError("No models available for this platform.");
    return;
  }

  const selection = await promptModelSelectionForOpenPlatform(
    host,
    models,
    platform,
  );
  if (selection === undefined) return;

  const existingConfig = await host.harness.getConfig();
  if (existingConfig.providers[platform.id] !== undefined) {
    await host.harness.removeProvider(platform.id);
  }

  const config = await host.harness.getConfig();
  applyOpenPlatformConfig(config as ManagedKimiConfigShape, {
    platform,
    models,
    selectedModel: selection.model,
    thinking: selection.thinking !== "off",
    effort:
      selection.thinking !== "off" && selection.thinking !== "on"
        ? selection.thinking
        : undefined,
    apiKey,
  });

  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: config.defaultModel,
    thinking: config.thinking,
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.track("login", { provider: platform.id, method: "api_key" });
  host.showStatus(`Setup complete: ${platform.name} · ${selection.model.id}`);
}

export async function handleLogoutCommand(
  host: SlashCommandHost,
): Promise<void> {
  const oauthStatus = await host.harness.auth.status(
    DEFAULT_OAUTH_PROVIDER_NAME,
  );
  const hasOAuthToken = oauthStatus.providers.some(
    (p) => p.providerName === DEFAULT_OAUTH_PROVIDER_NAME && p.hasToken,
  );
  const config = await host.harness.getConfig();
  const hasManagedRemnant =
    hasOAuthToken ||
    config.providers[DEFAULT_OAUTH_PROVIDER_NAME] !== undefined;
  const apiKeyProviderIds = Object.keys(config.providers ?? {})
    .filter((id) => id !== DEFAULT_OAUTH_PROVIDER_NAME)
    .toSorted();

  const options: ChoiceOption[] = [];
  if (hasManagedRemnant) {
    options.push({
      value: DEFAULT_OAUTH_PROVIDER_NAME,
      label: PRODUCT_NAME,
      description: "OAuth login",
    });
  }
  const optionIds = new Set(options.map((option) => option.value));
  for (const providerId of EXTERNAL_OAUTH_PROVIDER_IDS) {
    if (optionIds.has(providerId)) continue;
    try {
      const status = await host.harness.engineAuth.status(providerId);
      if (!status.loggedIn) continue;
      options.push({
        value: providerId,
        label: EXTERNAL_OAUTH_PROVIDER_LABELS[providerId] ?? providerId,
        description: "OAuth login",
      });
      optionIds.add(providerId);
    } catch (error) {
      log.warn("logout external oauth status failed", { providerId, error });
    }
  }
  try {
    const engineStatuses = await host.harness.engineAuth.summarize();
    for (const status of engineStatuses) {
      if (!status.loggedIn || status.provider === undefined) continue;
      if (
        status.provider === DEFAULT_OAUTH_PROVIDER_NAME ||
        optionIds.has(status.provider)
      ) {
        continue;
      }
      options.push({
        value: status.provider,
        label:
          EXTERNAL_OAUTH_PROVIDER_LABELS[status.provider] ?? status.provider,
        description: "OAuth login",
      });
      optionIds.add(status.provider);
    }
  } catch (error) {
    log.warn("logout provider discovery failed", { error });
  }
  for (const id of apiKeyProviderIds) {
    const baseUrl = config.providers[id]?.baseUrl;
    options.push({
      value: id,
      label: id,
      description:
        typeof baseUrl === "string" && baseUrl.length > 0 ? baseUrl : undefined,
    });
  }

  if (options.length === 0) {
    host.showStatus("Nothing to logout.");
    return;
  }

  const currentModel = host.state.appState.model.trim();
  const currentProvider =
    host.state.appState.availableModels[currentModel]?.provider;

  const target = await promptLogoutProviderSelection(
    host,
    options,
    currentProvider,
  );
  if (target === undefined) return;

  if (target === DEFAULT_OAUTH_PROVIDER_NAME) {
    await host.harness.auth.logout(DEFAULT_OAUTH_PROVIDER_NAME);
  } else if (EXTERNAL_OAUTH_PROVIDER_IDS.has(target)) {
    await host.harness.engineAuth.logout(target);
  } else {
    await host.harness.removeProvider(target);
  }

  if (target === currentProvider) {
    await host.authFlow.refreshConfigAfterLogout();
    await host.authFlow.clearActiveSessionAfterLogout();
  } else {
    const updated = await host.harness.getConfig({ reload: true });
    host.setAppState({
      availableModels: updated.models ?? {},
      availableProviders: updated.providers ?? {},
    });
  }

  host.track("logout", { provider: target });
  const label =
    target === DEFAULT_OAUTH_PROVIDER_NAME
      ? PRODUCT_NAME
      : (EXTERNAL_OAUTH_PROVIDER_LABELS[target] ?? target);
  host.showStatus(`Logged out from ${label}.`);
}
