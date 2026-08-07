import { i18n } from "../../../i18n";
import type { AppApprovalRequest, AppQuestionRequest, AppTask } from "../../../api/types";
import type {
  ApprovalBlock,
  DiffLine,
  TaskItem,
  TaskState,
  UIQuestion,
} from "../../../types";
import { rawState, sessionTimeClock, SESSION_TIME_CLOCK_INTERVAL_MS, enqueueEvent } from "./runtime";

export function isMainTurnActive(sessionId: string, listed?: boolean): boolean {
  return (
    (rawState.inFlightBySession[sessionId] ?? false) ||
    (rawState.turnActiveBySession[sessionId] ?? false) ||
    (listed ??
      rawState.sessions.find((session) => session.id === sessionId)
        ?.mainTurnActive ??
      false)
  );
}

/** Format createdAt/updatedAt into a short display string */
export function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffH = diffMs / 3600000;
    if (diffMs < 60000) return i18n.global.t("sessions.justNow");
    if (diffH < 1) return `${Math.round(diffMs / 60000)}m`;
    if (diffH < 24) return `${Math.round(diffH)}h`;
    const diffD = diffMs / 86400000;
    if (diffD < 7) return `${Math.round(diffD)}d`;
    if (diffD < 30) return `${Math.round(diffD / 7)}w`;
    if (diffD < 365) return `${Math.round(diffD / 30)}mo`;
    return `${Math.round(diffD / 365)}y`;
  } catch {
    return iso;
  }
}


export function ensureSessionTimeClock(): void {
  if (sessionTimeClockTimer !== null) return;
  sessionTimeClockTimer = setInterval(() => {
    sessionTimeClock.value =
      (sessionTimeClock.value + 1) % Number.MAX_SAFE_INTEGER;
  }, SESSION_TIME_CLOCK_INTERVAL_MS);
  (sessionTimeClockTimer as { unref?: () => void }).unref?.();
}

export function stopSessionTimeClock(): void {
  if (sessionTimeClockTimer === null) return;
  clearInterval(sessionTimeClockTimer);
  sessionTimeClockTimer = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopSessionTimeClock();
    enqueueEvent.dispose();
  });
}

/** Build DiffLine[] from old_text/new_text strings */
export function buildDiffLines(oldText: string, newText: string): DiffLine[] {
  const removed = oldText.split("\n");
  const added = newText.split("\n");
  const lines: DiffLine[] = [];
  removed.forEach((text, i) => {
    lines.push({ kind: "rem", gutter: String(i + 1), text: `- ${text}` });
  });
  added.forEach((text, i) => {
    lines.push({ kind: "add", gutter: String(i + 1), text: `+ ${text}` });
  });
  return lines;
}

/** Build ApprovalBlock from AppApprovalRequest (discriminated union) */
export function buildApprovalBlock(a: AppApprovalRequest): ApprovalBlock {
  // Cast display to a loose dict for defensive reading
  const d = (a.display ?? {}) as Record<string, unknown>;
  const kind = typeof d.kind === "string" ? d.kind : "";

  // diff
  if (kind === "diff") {
    const path = typeof d.path === "string" ? d.path : "";
    if (Array.isArray(d.diff)) {
      return { kind: "diff", path, diff: d.diff as DiffLine[] };
    }
    if (typeof d.old_text === "string" && typeof d.new_text === "string") {
      return {
        kind: "diff",
        path,
        diff: buildDiffLines(d.old_text, d.new_text),
      };
    }
    return { kind: "diff", path, diff: [] };
  }

  // shell / command
  if (kind === "shell" || kind === "command") {
    const command = typeof d.command === "string" ? d.command : a.action;
    const cwd = typeof d.cwd === "string" ? d.cwd : undefined;
    const danger = typeof d.danger === "string" ? d.danger : undefined;
    return { kind: "shell", command, cwd, danger };
  }

  // file_content / file
  if (kind === "file_content" || kind === "file") {
    const path = typeof d.path === "string" ? d.path : "";
    const content = typeof d.content === "string" ? d.content : "";
    const language = typeof d.language === "string" ? d.language : undefined;
    return { kind: "file", path, content, language };
  }

  // file_op / fileop
  if (kind === "file_op" || kind === "fileop") {
    const op =
      typeof d.operation === "string"
        ? d.operation
        : typeof d.op === "string"
          ? d.op
          : kind;
    const path = typeof d.path === "string" ? d.path : "";
    const detail = typeof d.detail === "string" ? d.detail : undefined;
    return { kind: "fileop", op, path, detail };
  }

  // url_fetch / url
  if (kind === "url_fetch" || kind === "url") {
    const url = typeof d.url === "string" ? d.url : a.action;
    const method = typeof d.method === "string" ? d.method : undefined;
    return { kind: "url", method, url };
  }

  // search
  if (kind === "search") {
    const query = typeof d.query === "string" ? d.query : a.action;
    const scope = typeof d.scope === "string" ? d.scope : undefined;
    return { kind: "search", query, scope };
  }

  // invocation / agent_call / skill_call
  if (kind === "invocation" || kind === "agent_call" || kind === "skill_call") {
    const kind2 = typeof d.kind === "string" ? d.kind : kind;
    const name = typeof d.name === "string" ? d.name : a.toolName;
    const description =
      typeof d.description === "string" ? d.description : undefined;
    return { kind: "invocation", kind2, name, description };
  }

  // todo / todo_list
  if (kind === "todo" || kind === "todo_list") {
    const rawItems = Array.isArray(d.items) ? d.items : [];
    const items = rawItems.map((item: unknown) => {
      const it = (item ?? {}) as Record<string, unknown>;
      return {
        title: typeof it.title === "string" ? it.title : "",
        status: typeof it.status === "string" ? it.status : "pending",
      };
    });
    return { kind: "todo", items };
  }

  // plan_review — finalised plan presented at plan-mode exit
  if (kind === "plan_review") {
    const plan = typeof d.plan === "string" ? d.plan : "";
    const path = typeof d.path === "string" ? d.path : undefined;
    const rawOptions = Array.isArray(d.options) ? d.options : [];
    const options = rawOptions
      .map((item: unknown): { label: string; description?: string } | null => {
        const it = (item ?? {}) as Record<string, unknown>;
        const label = typeof it.label === "string" ? it.label : "";
        if (!label) return null;
        const description =
          typeof it.description === "string" ? it.description : undefined;
        return { label, description };
      })
      .filter((o): o is { label: string; description?: string } => o !== null);
    return {
      kind: "plan_review",
      plan,
      path,
      options: options.length > 0 ? options : undefined,
    };
  }

  // Unknown daemon display.kind → 'generic' with summary = action
  return { kind: "generic", summary: a.action };
}

/** Map AppQuestionRequest to UIQuestion */
export function toUiQuestion(q: AppQuestionRequest): UIQuestion {
  return {
    questionId: q.questionId,
    sessionId: q.sessionId,
    questions: q.questions.map((qi) => ({
      id: qi.id,
      question: qi.question,
      header: qi.header,
      body: qi.body,
      options: qi.options.map((o) => ({
        id: o.id,
        label: o.label,
        description: o.description,
        recommended: o.recommended,
      })),
      multiSelect: qi.multiSelect,
      allowOther: qi.allowOther,
      otherLabel: qi.otherLabel,
    })),
  };
}

// messagesToTurns is imported from ./messagesToTurns (extracted module that
// groups consecutive assistant messages by promptId into a single turn).

/**
 * Try to recover the original bash command for a background task when the
 * task object itself does not carry it. The command lives in the matching
 * `Bash` tool_use message whose tool_result mentions this task's id.
 */
export function findBashCommandForTask(task: AppTask): string | undefined {
  const messages = rawState.messagesBySession[task.sessionId];
  if (!messages || messages.length === 0) return undefined;

  const bashCommandsByToolCallId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type !== "toolUse") continue;
      if (part.toolName !== "Bash" && part.toolName !== "bash") continue;
      const input = part.input as { command?: unknown } | undefined;
      const command =
        input && typeof input.command === "string" ? input.command : undefined;
      if (command) {
        bashCommandsByToolCallId.set(part.toolCallId, command);
      }
    }
  }
  if (bashCommandsByToolCallId.size === 0) return undefined;

  const taskIdMarker = `task_id: ${task.id}`;
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    for (const part of msg.content) {
      if (part.type !== "toolResult") continue;
      const outputText =
        typeof part.output === "string"
          ? part.output
          : part.output !== undefined
            ? JSON.stringify(part.output)
            : "";
      if (outputText.includes(taskIdMarker)) {
        const command = bashCommandsByToolCallId.get(part.toolCallId);
        if (command) return command;
      }
    }
  }
  return undefined;
}

/** Map AppTask to UI TaskItem */
export function toUiTask(task: AppTask): TaskItem {
  let state: TaskState;
  if (task.status === "running") {
    state = "run";
  } else if (task.status === "completed") {
    state = "done";
  } else {
    state = "fail";
  }

  // Compute timing string
  let timing = "";
  if (task.status === "running" && task.startedAt) {
    const elapsed = Math.round(
      (Date.now() - new Date(task.startedAt).getTime()) / 1000,
    );
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    timing = i18n.global.t("tasks.timingRunning", {
      time: `${m}:${String(s).padStart(2, "0")}`,
    });
  } else if (task.completedAt && task.startedAt) {
    const elapsed = Math.round(
      (new Date(task.completedAt).getTime() -
        new Date(task.startedAt).getTime()) /
        1000,
    );
    timing = i18n.global.t("tasks.timingDone", { sec: elapsed });
  } else {
    timing = task.status;
  }

  const output: string[] | undefined =
    task.outputLines && task.outputLines.length > 0
      ? task.outputLines
      : task.outputPreview
        ? task.outputPreview.split(/\r?\n/)
        : undefined;

  // Show the real terminal command for bash tasks so users can see what is
  // running without expanding the row. Fall back to the matching Bash tool_use
  // message when the task itself does not carry the command field.
  const command = task.command ?? findBashCommandForTask(task);
  const meta = task.kind === "bash" && command ? `$ ${command}` : undefined;

  return {
    id: task.id,
    name: task.description,
    kind: task.kind,
    state,
    timing,
    meta,
    output,
    runInBackground: task.runInBackground,
    parentToolCallId: task.parentToolCallId,
  };
}

let sessionTimeClockTimer: ReturnType<typeof setInterval> | null = null;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopSessionTimeClock();
    enqueueEvent.dispose();
  });
}
