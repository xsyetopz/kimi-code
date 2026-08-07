import {
  type ExperimentalFeatureState,
  type PermissionMode,
} from "@moonshot-ai/kimi-code-sdk";

import { EditorSelectorComponent } from "../components/dialogs/editor-selector";
import {
  ExperimentsSelectorComponent,
  type ExperimentalFeatureDraftChange,
} from "../components/dialogs/experiments-selector";
import { PermissionSelectorComponent } from "../components/dialogs/permission-selector";
import { ThemeSelectorComponent } from "../components/dialogs/theme-selector";
import { UpdatePreferenceSelectorComponent } from "../components/dialogs/update-preference-selector";
import { saveTuiConfig } from "../config";
import type { ThemeName } from "#/tui/theme";
import {
  currentTheme,
  isBuiltInTheme,
  lightColors,
  loadCustomThemeMerged,
} from "#/tui/theme";
import { NO_ACTIVE_SESSION_MESSAGE } from "../constant/kimi-tui";
import { formatErrorMessage } from "../utils/event-payload";
import { setExperimentalFeatures } from "./experimental-flags";
import type { SlashCommandHost } from "./dispatch";
import { currentTuiConfig } from "./config-shared";

export async function handleEditorCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const command = args.trim();
  if (command.length === 0) {
    showEditorPicker(host);
    return;
  }
  await applyEditorChoice(host, command);
}

export async function handleThemeCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const theme = args.trim();
  if (theme.length === 0) {
    showThemePicker(host);
    return;
  }
  if (!isBuiltInTheme(theme)) {
    const custom = await loadCustomThemeMerged(theme);
    if (custom === null) {
      host.showError(`Unknown theme: ${theme}`);
      return;
    }
  }
  await applyThemeChoice(host, theme);
}

export function showEditorPicker(host: SlashCommandHost): void {
  const currentValue = host.state.appState.editorCommand ?? "";
  host.mountEditorReplacement(
    new EditorSelectorComponent({
      currentValue,
      onSelect: (value) => {
        host.restoreEditor();
        void applyEditorChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyEditorChoice(
  host: SlashCommandHost,
  value: string,
): Promise<void> {
  const previous = host.state.appState.editorCommand ?? "";
  if (value === previous && value.length > 0) {
    host.showStatus(
      `Editor unchanged: ${value.length > 0 ? value : "auto-detect"}`,
    );
    return;
  }

  const editorCommand = value.length > 0 ? value : null;
  try {
    await saveTuiConfig({
      ...currentTuiConfig(host),
      editorCommand,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save editor: ${formatErrorMessage(error)}`,
      "error",
    );
    return;
  }

  host.setAppState({ editorCommand });
  host.showStatus(
    value.length > 0
      ? `Editor set to "${value}".`
      : "Editor set to auto-detect ($VISUAL / $EDITOR).",
  );
}

export function showThemePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new ThemeSelectorComponent({
      currentValue: host.state.appState.theme,
      onSelect: (value) => {
        host.restoreEditor();
        void applyThemeChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyThemeChoice(
  host: SlashCommandHost,
  theme: ThemeName,
): Promise<void> {
  if (theme === host.state.appState.theme) {
    if (theme === "auto") host.refreshTerminalThemeTracking();
    host.showStatus(`Theme unchanged: "${theme}".`);
    return;
  }

  // Validate custom themes up front so a missing / malformed file reports an
  // error instead of silently persisting a name that resolves to the dark
  // fallback.
  if (!isBuiltInTheme(theme)) {
    const palette = await loadCustomThemeMerged(theme);
    if (palette === null) {
      host.showStatus(`Theme "${theme}" could not be loaded.`, "error");
      return;
    }
  }

  try {
    await saveTuiConfig({
      ...currentTuiConfig(host),
      theme,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save theme: ${formatErrorMessage(error)}`,
      "error",
    );
    return;
  }

  const resolved =
    theme === "auto"
      ? currentTheme.palette === lightColors
        ? "light"
        : "dark"
      : undefined;
  await host.applyTheme(theme, resolved);
  host.refreshTerminalThemeTracking();
  host.track("theme_switch", { theme });
  const detail =
    theme === "auto" ? ` (tracking terminal; current: ${resolved})` : "";
  host.showStatus(`Theme set to "${theme}"${detail}.`);
}

export function showPermissionPicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new PermissionSelectorComponent({
      currentValue: host.state.appState.permissionMode,
      onSelect: (value) => {
        host.restoreEditor();
        void applyPermissionChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

export function showUpdatePreferencePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new UpdatePreferenceSelectorComponent({
      currentValue: host.state.appState.upgrade.autoInstall,
      onSelect: (value) => {
        host.restoreEditor();
        void applyUpdatePreferenceChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

export async function showExperimentsPanel(
  host: SlashCommandHost,
): Promise<void> {
  let features: readonly ExperimentalFeatureState[];
  try {
    features = await host.harness.getExperimentalFeatures();
  } catch (error) {
    host.showError(
      `Failed to load experimental features: ${formatErrorMessage(error)}`,
    );
    return;
  }
  mountExperimentsPanel(host, features);
}

export async function applyExperimentalFeatureChanges(
  host: SlashCommandHost,
  changes: readonly ExperimentalFeatureDraftChange[],
): Promise<void> {
  if (changes.length === 0) {
    host.showStatus("No experimental feature changes to apply.", "textMuted");
    return;
  }

  const experimental: Record<string, boolean> = {};
  for (const change of changes) {
    experimental[change.id] = change.enabled;
  }

  try {
    await host.harness.setConfig({ experimental });
    const features = await host.harness.getExperimentalFeatures();
    setExperimentalFeatures(features);
    host.refreshSlashCommandAutocomplete();
    host.restoreEditor();
    if (host.session !== undefined) {
      await host.session.reloadSession();
      await host.reloadCurrentSessionView(
        host.session,
        "Experimental features updated. Session reloaded.",
      );
    } else {
      host.showStatus("Experimental features updated.", "success");
    }
    host.track("experimental_features_apply", { changed: changes.length });
  } catch (error) {
    host.showError(
      `Failed to update experimental features: ${formatErrorMessage(error)}`,
    );
  }
}

function mountExperimentsPanel(
  host: SlashCommandHost,
  features: readonly ExperimentalFeatureState[],
): void {
  host.mountEditorReplacement(
    new ExperimentsSelectorComponent({
      features,
      onApply: (changes) => {
        void applyExperimentalFeatureChanges(host, changes);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

export type UpdatePreferenceHost = {
  readonly state: {
    readonly appState: Pick<
      SlashCommandHost["state"]["appState"],
      "theme" | "editorCommand" | "notifications" | "upgrade"
    >;
  };
  setAppState(
    patch: Pick<SlashCommandHost["state"]["appState"], "upgrade">,
  ): void;
  showStatus(msg: string, color?: string): void;
  track: SlashCommandHost["track"];
};

export async function applyUpdatePreferenceChoice(
  host: UpdatePreferenceHost,
  autoInstall: boolean,
): Promise<void> {
  if (autoInstall === host.state.appState.upgrade.autoInstall) {
    host.showStatus(
      `Automatic updates already ${autoInstall ? "enabled" : "disabled"}.`,
    );
    return;
  }

  const upgrade = { autoInstall };
  try {
    await saveTuiConfig({
      ...currentTuiConfig(host as unknown as SlashCommandHost),
      upgrade,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save automatic update setting: ${formatErrorMessage(error)}`,
      "error",
    );
    return;
  }

  host.setAppState({ upgrade });
  host.track("upgrade_preference_changed", { auto_install: autoInstall });
  host.showStatus(`Automatic updates ${autoInstall ? "enabled" : "disabled"}.`);
}

async function applyPermissionChoice(
  host: SlashCommandHost,
  mode: PermissionMode,
): Promise<void> {
  if (mode === host.state.appState.permissionMode) {
    host.showStatus(`Permission mode unchanged: ${mode}.`);
    return;
  }

  try {
    if (host.session !== undefined) {
      await host.session.setPermission(mode);
    } else if (!host.engineV2) {
      host.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }
    // v2 session-less: the chosen mode is recorded in appState and passed to
    // the lazy-created session.
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set permission mode: ${msg}`);
    return;
  }

  host.setAppState({ permissionMode: mode });
  host.showNotice(`Permission mode: ${mode}`);
}
