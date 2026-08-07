import type { Component, Focusable } from "@moonshot-ai/kimi-tui";

import * as slashCommands from "./commands/dispatch";
import type { StartupPanelsController } from "./controllers/startup-panels";
import type { KimiTUI } from "./kimi-tui";

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

export function installKimiTUIDialogDelegates(ctor: {
  prototype: KimiTUIDialogDelegates;
}): void {
  ctor.prototype.mountEditorReplacement = function (
    this: KimiTUI,
    panel: Component & Focusable,
  ): void {
    this.startupPanelsController.mountEditorReplacement(panel);
  };

  ctor.prototype.restoreEditor = function (this: KimiTUI): void {
    this.startupPanelsController.restoreEditor();
  };

  ctor.prototype.restoreInputText = function (
    this: KimiTUI,
    text: string,
  ): void {
    this.startupPanelsController.restoreInputText(text);
  };

  ctor.prototype.showHelpPanel = function (this: KimiTUI): void {
    this.startupPanelsController.showHelpPanel();
  };

  ctor.prototype.hideHelpPanel = function (this: KimiTUI): void {
    this.startupPanelsController.hideHelpPanel();
  };

  ctor.prototype.showApprovalPanel = function (
    this: KimiTUI,
    payload: Parameters<StartupPanelsController["showApprovalPanel"]>[0],
  ): void {
    this.startupPanelsController.showApprovalPanel(payload);
  };

  ctor.prototype.hideApprovalPanel = function (this: KimiTUI): void {
    this.startupPanelsController.hideApprovalPanel();
  };

  ctor.prototype.showQuestionDialog = function (
    this: KimiTUI,
    payload: Parameters<StartupPanelsController["showQuestionDialog"]>[0],
  ): void {
    this.startupPanelsController.showQuestionDialog(payload);
  };

  ctor.prototype.hideQuestionDialog = function (this: KimiTUI): void {
    this.startupPanelsController.hideQuestionDialog();
  };

  ctor.prototype.showSessionPicker = function (this: KimiTUI): Promise<void> {
    return this.startupPanelsController.showSessionPicker();
  };

  ctor.prototype.hideSessionPicker = function (this: KimiTUI): void {
    this.startupPanelsController.hideSessionPicker();
  };

  ctor.prototype.openUndoSelector = function (this: KimiTUI): void {
    void slashCommands.handleUndoCommand(this, "");
  };
}

declare module "./kimi-tui" {
  interface KimiTUI extends KimiTUIDialogDelegates {}
}
