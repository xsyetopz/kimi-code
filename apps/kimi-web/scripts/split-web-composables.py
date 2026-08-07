#!/usr/bin/env python3
from __future__ import annotations

import os
import re
import textwrap

ROOT = os.path.join(os.path.dirname(__file__), "..")
WSS = os.environ.get("WSS_SOURCE", os.path.join(ROOT, "src/composables/client/useWorkspaceState.ts"))
KWC = os.path.join(ROOT, "src/composables/useKimiWebClient.ts")
WS_DIR = os.path.join(ROOT, "src/composables/client/workspace-state")
KWC_DIR = os.path.join(ROOT, "src/composables/client/kimi-web-client")


def read_lines(path: str) -> list[str]:
    with open(path, encoding="utf-8") as f:
        return f.read().splitlines()


def write_file(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content.rstrip() + "\n")


def dedent_block(lines: list[str], spaces: int = 2) -> str:
    prefix = " " * spaces
    out: list[str] = []
    for line in lines:
        if line.startswith(prefix):
            out.append(line[spaces:])
        elif line == "":
            out.append("")
        else:
            out.append(line)
    return "\n".join(out)


def extract_inner(lines: list[str], start: int, end: int) -> str:
    return dedent_block(lines[start - 1 : end])


WS_SPLITS: list[tuple[str, int, int, list[str]]] = [
    (
        "git-diff-actions.ts",
        338,
        452,
        [
            "loadOlderMessages",
            "refreshSessionSidecars",
            "loadFileDiff",
            "clearFileDiff",
            "loadGitStatus",
        ],
    ),
    (
        "auth-config-actions.ts",
        453,
        526,
        ["checkAuth", "waitForFirstAuth", "loadConfig", "updateConfig"],
    ),
    (
        "session-load-actions.ts",
        527,
        988,
        [
            "listAllSessionsGlobal",
            "setSessionsPreservingLiveUsage",
            "mergePartialSessionsWithCached",
            "loadInitialSessionsForWorkspace",
            "loadInitialSessionsByWorkspace",
            "loadMoreSessions",
            "loadAllSessions",
            "refreshServerMeta",
            "load",
        ],
    ),
    (
        "workspace-actions.ts",
        989,
        1407,
        [
            "loadWorkspaces",
            "applyWorkspaceNameOverrides",
            "selectWorkspace",
            "openWorkspace",
            "upsertWorkspacePreserveOrder",
            "applyWorkspaceEvent",
            "clearActiveSession",
            "openWorkspaceDraft",
            "createDraftSession",
            "startSessionAndSendPrompt",
            "startSessionAndActivateSkill",
            "startSessionAndOpenSideChat",
            "addWorkspaceByPath",
            "browseFs",
            "getFsHome",
        ],
    ),
    (
        "session-route-actions.ts",
        1408,
        1548,
        [
            "writeSessionUrl",
            "fetchSessionIntoList",
            "onSessionRoutePopState",
            "bindSessionRoute",
            "selectSession",
        ],
    ),
    (
        "prompt-submit-actions.ts",
        1549,
        1942,
        ["submitPromptInternal", "sendPrompt", "steerPrompt", "uploadImage"],
    ),
    (
        "prompt-queue-actions.ts",
        1943,
        2152,
        ["enqueue", "flushQueueHead", "finishPromptLocal", "handleSessionSnapshot", "abortCurrentPrompt"],
    ),
    (
        "interaction-actions.ts",
        2153,
        2292,
        [
            "removePendingApproval",
            "removePendingQuestion",
            "respondApproval",
            "respondQuestion",
            "dismissQuestion",
            "cancelTask",
        ],
    ),
    (
        "mode-actions.ts",
        2293,
        2476,
        [
            "setPlanMode",
            "togglePlanMode",
            "setSwarmMode",
            "toggleSwarmMode",
            "setGoalMode",
            "toggleGoalMode",
            "createGoal",
            "controlGoal",
            "setPermission",
            "dismissWarning",
        ],
    ),
    (
        "crud-actions.ts",
        2477,
        2833,
        [
            "renameSession",
            "renameWorkspace",
            "deleteWorkspace",
            "archiveSession",
            "exportSession",
            "restoreSession",
            "loadArchivedSessions",
            "logout",
            "compact",
            "forkSession",
            "undo",
            "unqueue",
            "reorderQueue",
        ],
    ),
    (
        "fs-actions.ts",
        2835,
        3009,
        [
            "listDir",
            "readFileContent",
            "getFileDownloadUrl",
            "openWorkspaceFile",
            "openInApp",
            "revealWorkspaceFile",
            "resolveImageUrl",
            "searchFiles",
        ],
    ),
]

WS_IMPORTS = textwrap.dedent(
    """\
    import { getKimiWebApi } from "../../../api";
    import { i18n } from "../../../i18n";
    import { useConfirmDialog } from "../../useConfirmDialog";
    import { isDaemonApiError } from "../../../api/errors";
    import { SERVER_AUTH_UNAUTHORIZED_CODE } from "../../../api/daemon/http";
    import { isPlaceholderSessionUsage } from "../../../api/daemon/mappers";
    import type {
      AppConfig,
      AppInFlightTurn,
      AppMessage,
      AppSession,
      AppWorkspace,
      ApprovalDecision,
      ApprovalResponse,
      FsEntry,
      KimiEventConnection,
      QuestionResponse,
    } from "../../../api/types";
    import {
      loadWorkspaceNameOverrides,
      safeRemove,
      saveWorkspaceNameOverrides,
      STORAGE_KEYS,
    } from "../../../lib/storage";
    import { parseDiff } from "../../../lib/parseDiff";
    import { workspaceRootKey } from "../../../lib/rootKey";
    import { sessionExportTraceToJsonl, traceKeyEvent } from "../../../debug/trace";
    import { readSessionIdFromLocation, sessionUrl } from "../../../lib/sessionRoute";
    import type { SessionUrlMode } from "../../../lib/sessionRoute";
    import type {
      ActivityState,
      ConversationStatus,
      DiffViewLine,
      PermissionMode,
      WorkspaceView,
    } from "../../../types";
    import type { ExtendedState, PromptAttachment } from "../kimi-web-client/types";
    import type { UseWorkspaceStateDeps } from "./types";
    import type { WorkspaceStateCtx } from "./context";
    import {
      beginLocalTurn,
      settleLocalTurn,
      localTurnStartState,
      isLocalTurnSnapshotCurrent,
      afterLocalTurnStartsSettle,
    } from "./local-turn-state";
    import {
      MESSAGES_PAGE_SIZE,
      SESSIONS_INITIAL_PAGE_SIZE,
      PROMPT_NOT_FOUND_CODE,
      WORKSPACE_NOT_FOUND_CODE,
      ALREADY_RESOLVED_CODE,
      FIRST_LOAD_AUTH_RETRY_MS,
      TASK_ALREADY_FINISHED_CODE,
      MAX_QUEUE_FLUSH_FAILURES,
      isAlreadyResolvedError,
      isTaskAlreadyFinishedError,
      pendingQuestionActions,
      pendingApprovalActions,
      pendingTaskCancellations,
      startingFirstPromptWorkspaces,
      queueFlushFailures,
      nextQueueEntryId,
      type AuthCheckResult,
    } from "./shared";
    """
)


def indent_body(body: str, spaces: int = 2) -> str:
    prefix = " " * spaces
    return "\n".join(prefix + line if line else "" for line in body.split("\n"))


def build_ws_module(body: str, exports: list[str], factory: str) -> str:
    ret = "\n".join(f"    {e}," for e in exports)
    return (
        WS_IMPORTS
        + f"\nexport function {factory}(\n"
        + "  rawState: ExtendedState,\n"
        + "  deps: UseWorkspaceStateDeps,\n"
        + "  ctx: WorkspaceStateCtx,\n"
        + ") {\n"
        + "  const { t } = i18n.global;\n"
        + "  const { confirm } = useConfirmDialog();\n"
        + "  const {\n"
        + "    taskPoller,\n"
        + "    sideChat,\n"
        + "    modelProvider,\n"
        + "    pushOperationFailure,\n"
        + "    activity,\n"
        + "    sessionsKnownEmpty,\n"
        + "    setSessions,\n"
        + "    updateSession,\n"
        + "    upsertSessionFront,\n"
        + "    appendSession,\n"
        + "    forgetSession,\n"
        + "    setActiveSessionId,\n"
        + "    updateSessionMessages,\n"
        + "    nextOptimisticMsgId,\n"
        + "    getEventConn,\n"
        + "    syncSessionFromSnapshot,\n"
        + "    reopenSession,\n"
        + "    hasLoadedMessages,\n"
        + "    refreshSessionStatus,\n"
        + "    refreshSessionGoal,\n"
        + "    persistSessionProfile,\n"
        + "    mergedWorkspaces,\n"
        + "    workspacesView,\n"
        + "    status,\n"
        + "    workspaceIdForSession,\n"
        + "    savePermissionToStorage,\n"
        + "    savePlanModeToStorage,\n"
        + "    saveSwarmModeToStorage,\n"
        + "    saveGoalModeToStorage,\n"
        + "    draftModes,\n"
        + "    saveUnread,\n"
        + "    saveActiveWorkspaceToStorage,\n"
        + "    saveHiddenWorkspacesToStorage,\n"
        + "    goalErrorMessage,\n"
        + "    resetFastMoon,\n"
        + "    initialized,\n"
        + "    connectIssue,\n"
        + "    selectedDiffPath,\n"
        + "    fileDiffLines,\n"
        + "    fileDiffLoading,\n"
        + "  } = deps;\n"
        + "  let exportInFlight = false;\n\n"
        + indent_body(body)
        + "\n  return {\n"
        + ret
        + "\n  };\n"
        + "}\n"
    )


def rewrite_ws_body(body: str) -> str:
    # Replace direct sibling calls with ctx.* where needed — keep simple: only
    # cross-module calls that are known to be on ctx.
    replacements = [
        (r"\bselectSession\(", "ctx.selectSession("),
        (r"\bselectWorkspace\(", "ctx.selectWorkspace("),
        (r"\bopenWorkspace\(", "ctx.openWorkspace("),
        (r"\bopenWorkspaceDraft\(", "ctx.openWorkspaceDraft("),
        (r"\bcreateDraftSession\(", "ctx.createDraftSession("),
        (r"\bclearActiveSession\(", "ctx.clearActiveSession("),
        (r"\bwriteSessionUrl\(", "ctx.writeSessionUrl("),
        (r"\bbindSessionRoute\(", "ctx.bindSessionRoute("),
        (r"\bonSessionRoutePopState\(", "ctx.onSessionRoutePopState("),
        (r"\bfetchSessionIntoList\(", "ctx.fetchSessionIntoList("),
        (r"\bloadWorkspaces\(", "ctx.loadWorkspaces("),
        (r"\bload\(", "ctx.load("),
        (r"\bloadMoreSessions\(", "ctx.loadMoreSessions("),
        (r"\bloadAllSessions\(", "ctx.loadAllSessions("),
        (r"\bloadInitialSessionsByWorkspace\(", "ctx.loadInitialSessionsByWorkspace("),
        (r"\bloadInitialSessionsForWorkspace\(", "ctx.loadInitialSessionsForWorkspace("),
        (r"\brefreshSessionSidecars\(", "ctx.refreshSessionSidecars("),
        (r"\bsubmitPromptInternal\(", "ctx.submitPromptInternal("),
        (r"\bsendPrompt\(", "ctx.sendPrompt("),
        (r"\bflushQueueHead\(", "ctx.flushQueueHead("),
        (r"\bfinishPromptLocal\(", "ctx.finishPromptLocal("),
        (r"\babortCurrentPrompt\(", "ctx.abortCurrentPrompt("),
        (r"\bcheckAuth\(", "ctx.checkAuth("),
        (r"\bwaitForFirstAuth\(", "ctx.waitForFirstAuth("),
        (r"\bloadConfig\(", "ctx.loadConfig("),
        (r"\bupsertWorkspacePreserveOrder\(", "ctx.upsertWorkspacePreserveOrder("),
        (r"\bremovePendingApproval\(", "ctx.removePendingApproval("),
        (r"\bremovePendingQuestion\(", "ctx.removePendingQuestion("),
        (r"\bclearFileDiff\(", "ctx.clearFileDiff("),
        (r"\bloadGitStatus\(", "ctx.loadGitStatus("),
    ]
    # Don't rewrite definitions
    lines = body.split("\n")
    out: list[str] = []
    for line in lines:
        if re.match(r"^(async )?function \w+", line.strip()):
            out.append("  " + line if not line.startswith("  ") else line)
            continue
        new_line = line
        if not re.search(r"^\s*(async )?function ", line):
            for pat, rep in replacements:
                new_line = re.sub(pat, rep, new_line)
        out.append("  " + new_line if new_line and not new_line.startswith("  ") else new_line)
    return "\n".join(out)


def main() -> None:
    wss = read_lines(WSS)
    os.makedirs(WS_DIR, exist_ok=True)

    # types.ts from lines 209-286
    types_body = extract_inner(wss, 209, 286)
    write_file(
        os.path.join(WS_DIR, "types.ts"),
        textwrap.dedent(
            """\
            import type { ComputedRef, Ref } from "vue";
            import type {
              AppMessage,
              AppSession,
              AppWorkspace,
              KimiEventConnection,
            } from "../../../api/types";
            import type {
              ActivityState,
              ConversationStatus,
              DiffViewLine,
              PermissionMode,
              WorkspaceView,
            } from "../../../types";
            import type { UseModelProviderState } from "../useModelProviderState";
            import type { UseSideChat } from "../useSideChat";
            import type { UseTaskPoller } from "../useTaskPoller";

            """
        )
        + types_body.replace("type SyncSessionResult = \"ok\" | \"not-found\" | \"failed\";\n\n", "")
        + "\nexport type SyncSessionResult = \"ok\" | \"not-found\" | \"failed\";\n",
    )

    # shared + local-turn-state
    write_file(
        os.path.join(WS_DIR, "shared.ts"),
        textwrap.dedent(
            """\
            import { reactive } from "vue";
            import { isDaemonApiError } from "../../../api/errors";

            export const MESSAGES_PAGE_SIZE = 50;
            export const SESSIONS_INITIAL_PAGE_SIZE = 5;
            export const PROMPT_NOT_FOUND_CODE = 40402;
            export const WORKSPACE_NOT_FOUND_CODE = 40410;
            export const ALREADY_RESOLVED_CODE = 40902;
            export const FIRST_LOAD_AUTH_RETRY_MS = 2000;
            export const TASK_ALREADY_FINISHED_CODE = 40904;
            export const MAX_QUEUE_FLUSH_FAILURES = 3;

            export type AuthCheckResult = "proceed" | "retry" | "server-auth-required";

            export function isAlreadyResolvedError(err: unknown): boolean {
              return isDaemonApiError(err) && err.code === ALREADY_RESOLVED_CODE;
            }

            export function isTaskAlreadyFinishedError(err: unknown): boolean {
              return isDaemonApiError(err) && err.code === TASK_ALREADY_FINISHED_CODE;
            }

            export const pendingQuestionActions = reactive<Record<string, "answer" | "dismiss">>({});
            export const pendingApprovalActions = reactive<Record<string, true>>({});
            export const pendingTaskCancellations = reactive<Record<string, true>>({});
            export const startingFirstPromptWorkspaces = reactive(new Set<string>());
            export const queueFlushFailures = new Map<string, { key: string; count: number }>();

            let queueEntryCounter = 0;
            export function nextQueueEntryId(): string {
              queueEntryCounter += 1;
              return `${Date.now().toString(36)}-${queueEntryCounter}`;
            }
            """
        ),
    )

    write_file(
        os.path.join(WS_DIR, "local-turn-state.ts"),
        textwrap.dedent(
            """\
            import { queueFlushFailures } from "./shared";

            const promptGenerationBySession = new Map<string, number>();
            const pendingLocalTurnStarts = new Map<string, Set<number>>();
            const afterLocalTurnsSettled = new Map<string, () => void>();
            let nextLocalTurnToken = 0;

            export interface LocalTurnStartState {
              generation: number;
              pending: boolean;
            }

            export function localTurnStartState(sid: string): LocalTurnStartState {
              return {
                generation: promptGenerationBySession.get(sid) ?? 0,
                pending: (pendingLocalTurnStarts.get(sid)?.size ?? 0) > 0,
              };
            }

            export function beginLocalTurn(sid: string): number {
              const token = ++nextLocalTurnToken;
              promptGenerationBySession.set(sid, token);
              const pending = pendingLocalTurnStarts.get(sid) ?? new Set<number>();
              pending.add(token);
              pendingLocalTurnStarts.set(sid, pending);
              return token;
            }

            export function settleLocalTurn(sid: string, token: number): void {
              const pending = pendingLocalTurnStarts.get(sid);
              if (pending === undefined) return;
              pending.delete(token);
              if (pending.size > 0) return;
              pendingLocalTurnStarts.delete(sid);
              const callback = afterLocalTurnsSettled.get(sid);
              afterLocalTurnsSettled.delete(sid);
              callback?.();
            }

            export function forgetLocalTurnState(sid: string): void {
              promptGenerationBySession.delete(sid);
              pendingLocalTurnStarts.delete(sid);
              afterLocalTurnsSettled.delete(sid);
              queueFlushFailures.delete(sid);
            }

            export function isLocalTurnSnapshotCurrent(
              sid: string,
              atRequest: LocalTurnStartState,
            ): boolean {
              return (
                !atRequest.pending &&
                atRequest.generation === (promptGenerationBySession.get(sid) ?? 0)
              );
            }

            export function afterLocalTurnStartsSettle(
              sid: string,
              callback: () => void,
            ): void {
              if ((pendingLocalTurnStarts.get(sid)?.size ?? 0) === 0) {
                callback();
                return;
              }
              afterLocalTurnsSettled.set(sid, callback);
            }
            """
        ),
    )

    CTX_REWRITES: dict[str, list[tuple[str, str]]] = {
        "session-load-actions.ts": [
            (r"(?<!function )(?<![.\w])load\(", "ctx.load("),
            (r"(?<!function )(?<![.\w])loadWorkspaces\(", "ctx.loadWorkspaces("),
            (r"(?<!function )(?<![.\w])bindSessionRoute\(", "ctx.bindSessionRoute("),
            (r"(?<!function )(?<![.\w])selectSession\(", "ctx.selectSession("),
            (r"(?<!function )(?<![.\w])selectWorkspace\(", "ctx.selectWorkspace("),
            (r"(?<!function )(?<![.\w])fetchSessionIntoList\(", "ctx.fetchSessionIntoList("),
            (r"(?<!function )(?<![.\w])loadMoreSessions\(", "ctx.loadMoreSessions("),
            (r"(?<!function )(?<![.\w])loadAllSessions\(", "ctx.loadAllSessions("),
            (r"(?<!function )(?<![.\w])waitForFirstAuth\(", "ctx.waitForFirstAuth("),
            (r"(?<!function )(?<![.\w])loadConfig\(", "ctx.loadConfig("),
            (r"(?<!function )(?<![.\w])checkAuth\(", "ctx.checkAuth("),
        ],
        "workspace-actions.ts": [
            (r"(?<!function )(?<![.\w])selectSession\(", "ctx.selectSession("),
            (r"(?<!function )(?<![.\w])selectWorkspace\(", "ctx.selectWorkspace("),
            (r"(?<!function )(?<![.\w])openWorkspace\(", "ctx.openWorkspace("),
            (r"(?<!function )(?<![.\w])openWorkspaceDraft\(", "ctx.openWorkspaceDraft("),
            (r"(?<!function )(?<![.\w])createDraftSession\(", "ctx.createDraftSession("),
            (r"(?<!function )(?<![.\w])clearActiveSession\(", "ctx.clearActiveSession("),
            (r"(?<!function )(?<![.\w])upsertWorkspacePreserveOrder\(", "ctx.upsertWorkspacePreserveOrder("),
            (r"(?<!function )(?<![.\w])sendPrompt\(", "ctx.sendPrompt("),
            (r"(?<!function )(?<![.\w])writeSessionUrl\(", "ctx.writeSessionUrl("),
            (r"(?<!function )(?<![.\w])clearFileDiff\(", "ctx.clearFileDiff("),
            (r"(?<!function )(?<![.\w])submitPromptInternal\(", "ctx.submitPromptInternal("),
        ],
        "session-route-actions.ts": [
            (r"(?<!function )(?<![.\w])selectSession\(", "ctx.selectSession("),
            (r"(?<!function )(?<![.\w])selectWorkspace\(", "ctx.selectWorkspace("),
            (r"(?<!function )(?<![.\w])refreshSessionSidecars\(", "ctx.refreshSessionSidecars("),
            (r"(?<!function )(?<![.\w])clearFileDiff\(", "ctx.clearFileDiff("),
        ],
        "prompt-submit-actions.ts": [
            (r"(?<!function )(?<![.\w])flushQueueHead\(", "ctx.flushQueueHead("),
            (r"(?<!function )(?<![.\w])enqueue\(", "ctx.enqueue("),
        ],
        "prompt-queue-actions.ts": [
            (r"(?<!function )(?<![.\w])submitPromptInternal\(", "ctx.submitPromptInternal("),
            (r"(?<!function )(?<![.\w])flushQueueHead\(", "ctx.flushQueueHead("),
        ],
        "crud-actions.ts": [
            (r"(?<!function )(?<![.\w])selectSession\(", "ctx.selectSession("),
            (r"(?<!function )(?<![.\w])selectWorkspace\(", "ctx.selectWorkspace("),
            (r"(?<!function )(?<![.\w])clearActiveSession\(", "ctx.clearActiveSession("),
            (r"(?<!function )(?<![.\w])writeSessionUrl\(", "ctx.writeSessionUrl("),
            (r"(?<!function )(?<![.\w])loadWorkspaces\(", "ctx.loadWorkspaces("),
            (r"(?<!function )(?<![.\w])checkAuth\(", "ctx.checkAuth("),
            (r"(?<!function )(?<![.\w])load\(", "ctx.load("),
            (r"(?<!function )(?<![.\w])clearFileDiff\(", "ctx.clearFileDiff("),
        ],
        "mode-actions.ts": [
            (r"(?<!function )(?<![.\w])sendPrompt\(", "ctx.sendPrompt("),
            (r"(?<!function )(?<![.\w])createDraftSession\(", "ctx.createDraftSession("),
            (r"(?<!function )(?<![.\w])submitPromptInternal\(", "ctx.submitPromptInternal("),
        ],
    }

    all_exports: list[str] = []
    for filename, start, end, exports in WS_SPLITS:
        body = extract_inner(wss, start, end)
        for pat, rep in CTX_REWRITES.get(filename, []):
            body = re.sub(pat, rep, body)
        factory = (
            "create"
            + "".join(
                p[:1].upper() + p[1:]
                for p in filename.replace(".ts", "").split("-")
            )
        )
        content = build_ws_module(body, exports, factory)
        content = content.replace('from "../../api/types"', 'from "../../../api/types"')
        content = content.replace('import("../../api/types"', 'import("../../../api/types"')
        write_file(os.path.join(WS_DIR, filename), content)
        all_exports.extend(exports)
        print(f"Wrote {filename}: {end-start+1} lines, {len(exports)} exports")

    write_file(
        os.path.join(WS_DIR, "context.ts"),
        "// Cross-module call surface for workspace-state capability factories.\n"
        "// eslint-disable-next-line @typescript-eslint/no-explicit-any\n"
        "export type WorkspaceStateCtx = Record<string, any>;\n",
    )

    print("Total exports:", len(all_exports))


if __name__ == "__main__":
    main()
