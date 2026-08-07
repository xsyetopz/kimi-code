import type { DeviceAuthorization } from "@moonshot-ai/kimi-code-oauth";
import type { ApprovalRequest, ApprovalResponse } from "@moonshot-ai/kimi-code-sdk";

import type { ColorToken } from "./theme";
import type { AgentGroupViewState } from "./projections/tool-call/agent-group";
import type { ReadGroupViewState } from "./projections/tool-call/read-group";
import type {
  CompactionTranscriptData,
  LoginProgressSpinnerHandle,
  ShellRunViewState,
  ToolCallBlockData,
  TranscriptEntry,
} from "./types";
import { KimiTUI } from "./kimi-tui";

export interface KimiTUITranscriptDelegates {
  appendTranscriptEntry(entry: TranscriptEntry): void;
  syncToolCallTranscriptEntry(
    toolCallId: string,
    data: ToolCallBlockData,
  ): void;
  syncShellRunTranscriptEntry(
    entryId: string,
    data: ShellRunViewState,
  ): void;
  syncCompactionTranscriptEntry(
    entryId: string,
    data: CompactionTranscriptData,
  ): void;
  syncAgentGroupTranscriptEntry(
    entryId: string,
    data: AgentGroupViewState,
    memberToolCallIds: readonly string[],
  ): void;
  syncReadGroupTranscriptEntry(
    entryId: string,
    data: ReadGroupViewState,
    memberToolCallIds: readonly string[],
  ): void;
  removeToolCallTranscriptEntry(toolCallId: string): void;
  appendApprovalTranscriptEntry(
    request: ApprovalRequest,
    response: ApprovalResponse,
  ): void;
  clearTranscriptAndRedraw(): void;
  mergeCurrentTurnSteps(): boolean;
  mergeCompletedTurnAssistants(): boolean;
  mergeAllTurnSteps(): void;
  showStatus(message: string, color?: ColorToken): void;
  showNotice(title: string, detail?: string): void;
  showError(message: string): void;
  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle;
  showProgressSpinner(label: string): LoginProgressSpinnerHandle;
  showLoginAuthorizationPrompt(
    auth: DeviceAuthorization,
  ): LoginProgressSpinnerHandle;
}

KimiTUI.prototype.appendTranscriptEntry = function (
  this: KimiTUI,
  entry: TranscriptEntry,
): void {
  this.transcriptCoordinator.appendTranscriptEntry(entry);
};

KimiTUI.prototype.syncToolCallTranscriptEntry = function (
  this: KimiTUI,
  toolCallId: string,
  data: ToolCallBlockData,
): void {
  this.transcriptCoordinator.syncToolCallTranscriptEntry(toolCallId, data);
};

KimiTUI.prototype.syncShellRunTranscriptEntry = function (
  this: KimiTUI,
  entryId: string,
  data: ShellRunViewState,
): void {
  this.transcriptCoordinator.syncShellRunTranscriptEntry(entryId, data);
};

KimiTUI.prototype.syncCompactionTranscriptEntry = function (
  this: KimiTUI,
  entryId: string,
  data: CompactionTranscriptData,
): void {
  this.transcriptCoordinator.syncCompactionTranscriptEntry(entryId, data);
};

KimiTUI.prototype.syncAgentGroupTranscriptEntry = function (
  this: KimiTUI,
  entryId: string,
  data: AgentGroupViewState,
  memberToolCallIds: readonly string[],
): void {
  this.transcriptCoordinator.syncAgentGroupTranscriptEntry(
    entryId,
    data,
    memberToolCallIds,
  );
};

KimiTUI.prototype.syncReadGroupTranscriptEntry = function (
  this: KimiTUI,
  entryId: string,
  data: ReadGroupViewState,
  memberToolCallIds: readonly string[],
): void {
  this.transcriptCoordinator.syncReadGroupTranscriptEntry(
    entryId,
    data,
    memberToolCallIds,
  );
};

KimiTUI.prototype.removeToolCallTranscriptEntry = function (
  this: KimiTUI,
  toolCallId: string,
): void {
  this.transcriptCoordinator.removeToolCallTranscriptEntry(toolCallId);
};

KimiTUI.prototype.appendApprovalTranscriptEntry = function (
  this: KimiTUI,
  request: ApprovalRequest,
  response: ApprovalResponse,
): void {
  this.transcriptCoordinator.appendApprovalTranscriptEntry(request, response);
};

KimiTUI.prototype.clearTranscriptAndRedraw = function (this: KimiTUI): void {
  this.transcriptCoordinator.clearTranscriptAndRedraw();
};

KimiTUI.prototype.mergeCurrentTurnSteps = function (this: KimiTUI): boolean {
  return this.transcriptCoordinator.mergeCurrentTurnSteps();
};

KimiTUI.prototype.mergeCompletedTurnAssistants = function (
  this: KimiTUI,
): boolean {
  return this.transcriptCoordinator.mergeCompletedTurnAssistants();
};

KimiTUI.prototype.mergeAllTurnSteps = function (this: KimiTUI): void {
  this.transcriptCoordinator.mergeAllTurnSteps();
};

KimiTUI.prototype.showStatus = function (
  this: KimiTUI,
  message: string,
  color?: ColorToken,
): void {
  this.transcriptCoordinator.showStatus(message, color);
};

KimiTUI.prototype.showNotice = function (
  this: KimiTUI,
  title: string,
  detail?: string,
): void {
  this.transcriptCoordinator.showNotice(title, detail);
};

KimiTUI.prototype.showError = function (this: KimiTUI, message: string): void {
  this.transcriptCoordinator.showError(message);
};

KimiTUI.prototype.showLoginProgressSpinner = function (
  this: KimiTUI,
  label: string,
): LoginProgressSpinnerHandle {
  return this.transcriptCoordinator.showLoginProgressSpinner(label);
};

KimiTUI.prototype.showProgressSpinner = function (
  this: KimiTUI,
  label: string,
): LoginProgressSpinnerHandle {
  return this.transcriptCoordinator.showProgressSpinner(label);
};

KimiTUI.prototype.showLoginAuthorizationPrompt = function (
  this: KimiTUI,
  auth: DeviceAuthorization,
  title?: string,
): LoginProgressSpinnerHandle {
  return this.transcriptCoordinator.showLoginAuthorizationPrompt(auth, title);
};

declare module "./kimi-tui" {
  interface KimiTUI extends KimiTUITranscriptDelegates {}
}
