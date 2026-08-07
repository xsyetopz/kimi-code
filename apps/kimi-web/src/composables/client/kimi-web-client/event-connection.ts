import { getKimiWebApi } from "../../../api";
import { i18n } from "../../../i18n";
import { traceKeyEvent } from "../../../debug/trace";
import type { AppNoticeDetail } from "../../../api/types";
import {
  coalesceAppRenderEvents,
  createEventBatcher,
  isRenderEvent,
  splitOversizedAppRenderEvent,
  type PendingAppEvent,
} from "../eventBatcher";
import {
  rawState,
  eventConn,
  sessionsRequiringSnapshot,
  workspaceState,
  setEventConn,
  enqueueEvent,
} from "./runtime";
import { processEvent } from "./event-handlers";
import {
  pushWarning,
  dismissWsError,
  warningDetail,
  snapshotSyncRunner,
} from "./warnings-snapshot";

export function connectEventsIfNeeded(): void {
  if (eventConn !== null) return;
  // Guard: jsdom and some environments have no WebSocket
  if (typeof WebSocket === "undefined") return;

  traceKeyEvent("ws:connection", { status: "connecting" });
  rawState.connection = "connecting";

  const api = getKimiWebApi();

  setEventConn(api.connectEvents({
    onEvent(appEvent, meta) {
      // Workspace lifecycle events are global (not session-scoped) and update
      // rawState.workspaces directly — they bypass the reducer, which has no
      // workspace state.
      if (
        appEvent.type === "workspaceCreated" ||
        appEvent.type === "workspaceUpdated" ||
        appEvent.type === "workspaceDeleted"
      ) {
        workspaceState!.applyWorkspaceEvent(appEvent);
        return;
      }

      // Merge safe streaming chunks, then process the ordered queue in bounded
      // slices. See createEventBatcher / processEvent above.
      for (const pendingEvent of splitOversizedAppRenderEvent({
        appEvent,
        meta,
      })) {
        enqueueEvent(pendingEvent);
      }
    },

    onResync(sessionId: string, currentSeq: number, epoch?: string) {
      traceKeyEvent("ws:resync", {
        sessionId,
        status: "required",
        seq: currentSeq,
      });
      // Flush streaming deltas already queued so they render on the
      // pre-snapshot state (the snapshot is authoritative and will overwrite
      // them). Stragglers that arrive during the snapshot fetch are drained
      // again right before the snapshot write inside syncSessionFromSnapshot,
      // so they are applied to the pre-snapshot array too rather than on top
      // of the fresh snapshot (which would duplicate text / tool output).
      enqueueEvent.flush();
      // The server-announced cursor is only a hint; keep the previous epoch
      // until the snapshot arrives so seq values from two epochs are never
      // compared with each other.
      void currentSeq;
      void epoch;
      sessionsRequiringSnapshot.add(sessionId);
      snapshotSyncRunner.request(sessionId);
    },

    onError(code: number, msg: string, fatal: boolean) {
      traceKeyEvent("ws:error", {
        status: "failed",
        errorCode: code,
        fatal,
      });
      pushWarning({
        severity: "error",
        title: i18n.global.t("warnings.wsTitle"),
        message: msg,
        details: [warningDetail("message", msg)].filter(
          (detail): detail is AppNoticeDetail => detail !== undefined,
        ),
      });
    },

    onConnectionChange(connected: boolean) {
      traceKeyEvent("ws:connection", {
        status: connected ? "connected" : "disconnected",
      });
      rawState.connected = connected;
      rawState.connection = connected ? "connected" : "disconnected";
      // The data channel is healthy again (server_hello received). Clear any
      // stale "Realtime connection error" toast instead of relying on its
      // auto-dismiss timer: iOS Safari freezes timers while a tab is
      // backgrounded, so the toast would otherwise linger until a manual
      // refresh even though the reconnect already succeeded.
      if (connected) {
        dismissWsError();
        // A reconnect can follow a server restart. Re-read /meta so server
        // metadata does not go stale.
        void workspaceState!.refreshServerMeta();
      }
    },
  }));
}

import { setEnqueueEvent } from "./runtime";

export function initEnqueueEvent(): void {
  setEnqueueEvent(
    createEventBatcher<PendingAppEvent>(
      ({ appEvent, meta }) => processEvent(appEvent, meta),
      ({ appEvent }) => isRenderEvent(appEvent),
      { coalesce: coalesceAppRenderEvents },
    ),
  );
}
