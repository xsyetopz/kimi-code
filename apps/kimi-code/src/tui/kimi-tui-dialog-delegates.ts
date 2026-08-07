import type { Component, Focusable } from "@moonshot-ai/kimi-tui";

import * as slashCommands from "./commands/dispatch";
import type { StartupPanelsController } from "./controllers/startup-panels";
import { KimiTUI } from "./kimi-tui";

export interface KimiTUIDialogDelegates {
  mountEditorReplacement(panel: Component & Focusable): void;
  restoreEditor(): void;
  restoreInputText(text: string): void;
  showHelpPanel(): void;
  hideHelpPanel(): void;
  showApprovalPanel(
    payload: Parameters<StartupPanelsController["showApprovalPanel"]>[0],
  ): void;
  hideApprovalPanel(): void;
  showQuestionDialog(
    payload: Parameters<StartupPanelsController["showQuestionDialog"]>[0],
  ): void;
  hideQuestionDialog(): void;
  showSessionPicker(): Promise<void>;
  hideSessionPicker(): void;
  openUndoSelector(): void;
}

KimiTUI.prototype.mountEditorReplacement = function (
  this: KimiTUI,
  panel: Component & Focusable,
): void {
  this.startupPanelsController.mountEditorReplacement(panel);
};

KimiTUI.prototype.restoreEditor = function (this: KimiTUI): void {
  this.startupPanelsController.restoreEditor();
};

KimiTUI.prototype.restoreInputText = function (
  this: KimiTUI,
  text: string,
): void {
  this.startupPanelsController.restoreInputText(text);
};

KimiTUI.prototype.showHelpPanel = function (this: KimiTUI): void {
  this.startupPanelsController.showHelpPanel();
};

KimiTUI.prototype.hideHelpPanel = function (this: KimiTUI): void {
  this.startupPanelsController.hideHelpPanel();
};

KimiTUI.prototype.showApprovalPanel = function (
  this: KimiTUI,
  payload: Parameters<StartupPanelsController["showApprovalPanel"]>[0],
): void {
  this.startupPanelsController.showApprovalPanel(payload);
};

KimiTUI.prototype.hideApprovalPanel = function (this: KimiTUI): void {
  this.startupPanelsController.hideApprovalPanel();
};

KimiTUI.prototype.showQuestionDialog = function (
  this: KimiTUI,
  payload: Parameters<StartupPanelsController["showQuestionDialog"]>[0],
): void {
  this.startupPanelsController.showQuestionDialog(payload);
};

KimiTUI.prototype.hideQuestionDialog = function (this: KimiTUI): void {
  this.startupPanelsController.hideQuestionDialog();
};

KimiTUI.prototype.showSessionPicker = function (this: KimiTUI): Promise<void> {
  return this.startupPanelsController.showSessionPicker();
};

KimiTUI.prototype.hideSessionPicker = function (this: KimiTUI): void {
  this.startupPanelsController.hideSessionPicker();
};

KimiTUI.prototype.openUndoSelector = function (this: KimiTUI): void {
  void slashCommands.handleUndoCommand(this, "");
};

declare module "./kimi-tui" {
  interface KimiTUI extends KimiTUIDialogDelegates {}
}
