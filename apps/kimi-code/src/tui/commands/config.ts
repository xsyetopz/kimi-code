import type { Session } from "@moonshot-ai/kimi-code-sdk";

import {
  SettingsSelectorComponent,
  type SettingsSelection,
} from "../components/dialogs/settings-selector";
import { NO_ACTIVE_SESSION_MESSAGE } from "../constant/kimi-tui";
import { formatErrorMessage } from "../utils/event-payload";
import { showUsage } from "./info";
import type { SlashCommandHost } from "./dispatch";
import {
  showEditorPicker,
  showExperimentsPanel,
  showPermissionPicker,
  showThemePicker,
  showUpdatePreferencePicker,
} from "./config-pickers";
import { showModelPicker } from "./config-model";

export { effectiveModelForHost } from "./config-shared";
export {
  handleEditorCommand,
  handleThemeCommand,
  showPermissionPicker,
  showUpdatePreferencePicker,
  showExperimentsPanel,
  applyExperimentalFeatureChanges,
  applyUpdatePreferenceChoice,
  type UpdatePreferenceHost,
} from "./config-pickers";
export {
  handleModelCommand,
  handleSecondaryModelCommand,
  handleEffortCommand,
  showModelPicker,
} from "./config-model";

export async function handlePlanCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const subcmd = args.trim().toLowerCase();
  if (subcmd === "clear") {
    await session.clearPlan();
    host.showNotice("Plan cleared");
    return;
  }

  let enabled: boolean;
  if (subcmd.length === 0) enabled = !host.state.appState.planMode;
  else if (subcmd === "on") enabled = true;
  else if (subcmd === "off") enabled = false;
  else {
    host.showError(`Unknown plan subcommand: ${subcmd}`);
    return;
  }

  // The session may already be in the requested mode (e.g. it was created
  // with config.defaultPlanMode applied), and re-entering plan mode throws.
  if (host.state.appState.planMode === enabled) {
    host.showNotice(`Plan mode is already ${enabled ? "on" : "off"}`);
    return;
  }

  await applyPlanMode(host, session, enabled);
}

async function applyPlanMode(
  host: SlashCommandHost,
  session: Session,
  enabled: boolean,
): Promise<void> {
  try {
    await session.setPlanMode(enabled);
    host.setAppState({ planMode: enabled });
    if (enabled) {
      const plan = await session.getPlan().catch(() => null);
      host.showNotice(
        "Plan mode: ON",
        plan?.path !== undefined
          ? `Plan will be created here: ${plan.path}`
          : undefined,
      );
      return;
    }
    host.showNotice("Plan mode: OFF");
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set plan mode: ${msg}`);
  }
}

export async function handleYoloCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const session = host.session;
  if (session === undefined && !host.engineV2) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  // v2 session-less: the chosen mode is recorded in appState and passed to the
  // lazy-created session; apply the runtime permission only when one exists.

  const subcmd = args.trim().toLowerCase();
  const currentMode = host.state.appState.permissionMode;

  if (subcmd === "on") {
    if (currentMode === "yolo") {
      host.showNotice("YOLO mode is already on");
      return;
    }
    await session?.setPermission("yolo");
    host.setAppState({ permissionMode: "yolo" });
    host.showNotice(
      "YOLO mode: ON",
      "Tool actions auto-approved; the agent may still ask you questions.",
    );
    return;
  }

  if (subcmd === "off") {
    if (currentMode !== "yolo") {
      host.showNotice("YOLO mode is already off");
      return;
    }
    await session?.setPermission("manual");
    host.setAppState({ permissionMode: "manual" });
    host.showNotice("YOLO mode: OFF");
    return;
  }

  // toggle
  if (currentMode === "yolo") {
    await session?.setPermission("manual");
    host.setAppState({ permissionMode: "manual" });
    host.showNotice("YOLO mode: OFF");
  } else {
    await session?.setPermission("yolo");
    host.setAppState({ permissionMode: "yolo" });
    host.showNotice(
      "YOLO mode: ON",
      "Tool actions auto-approved; the agent may still ask you questions.",
    );
  }
}

export async function handleAutoCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const session = host.session;
  if (session === undefined && !host.engineV2) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  // v2 session-less: the chosen mode is recorded in appState and passed to the
  // lazy-created session; apply the runtime permission only when one exists.

  const subcmd = args.trim().toLowerCase();
  const currentMode = host.state.appState.permissionMode;

  if (subcmd === "on") {
    if (currentMode === "auto") {
      host.showNotice("Auto mode is already on");
      return;
    }
    await session?.setPermission("auto");
    host.setAppState({ permissionMode: "auto" });
    host.showNotice(
      "Auto mode: ON",
      "All actions auto-approved; the agent will not ask you questions.",
    );
    return;
  }

  if (subcmd === "off") {
    if (currentMode !== "auto") {
      host.showNotice("Auto mode is already off");
      return;
    }
    await session?.setPermission("manual");
    host.setAppState({ permissionMode: "manual" });
    host.showNotice("Auto mode: OFF");
    return;
  }

  // toggle
  if (currentMode === "auto") {
    await session?.setPermission("manual");
    host.setAppState({ permissionMode: "manual" });
    host.showNotice("Auto mode: OFF");
  } else {
    await session?.setPermission("auto");
    host.setAppState({ permissionMode: "auto" });
    host.showNotice(
      "Auto mode: ON",
      "All actions auto-approved; the agent will not ask you questions.",
    );
  }
}

export async function handleCompactCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  const customInstruction = args.trim() || undefined;
  await session.compact({ instruction: customInstruction });
}

export function showSettingsSelector(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new SettingsSelectorComponent({
      onSelect: (value) => {
        handleSettingsSelection(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function handleSettingsSelection(
  host: SlashCommandHost,
  value: SettingsSelection,
): void {
  host.restoreEditor();
  switch (value) {
    case "model":
      showModelPicker(host);
      return;
    case "permission":
      showPermissionPicker(host);
      return;
    case "theme":
      showThemePicker(host);
      return;
    case "editor":
      showEditorPicker(host);
      return;
    case "experiments":
      void showExperimentsPanel(host);
      return;
    case "upgrade":
      showUpdatePreferencePicker(host);
      return;
    case "usage":
      void showUsage(host);
      return;
  }
}
