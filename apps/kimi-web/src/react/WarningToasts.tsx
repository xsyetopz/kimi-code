import { useEffect, useRef, useState } from "react";

import type { AppNotice, AppWarning } from "../api/types";
import { copyTextToClipboard } from "../lib/clipboard";
import { iconSvg, type IconName } from "../lib/icons";

/** Localized copy supplied by the Vue host while the shell is migrating. */
export interface WarningToastsLabels {
  dismiss: string;
  errorLabel: string;
  diagnostics: string;
  hideDetails: string;
  showDetails: string;
  copyDetails: string;
  copied: string;
}

export interface WarningToastsProps {
  warnings: AppWarning[];
  labels: WarningToastsLabels;
  onDismiss: (index: number) => void;
}

export function isNotice(warning: AppWarning): warning is AppNotice {
  return typeof warning === "object" && warning !== null;
}

export function toastTitle(warning: AppWarning): string {
  return isNotice(warning) ? warning.title : warning;
}

export function toastMessage(warning: AppWarning): string {
  return isNotice(warning) ? (warning.message ?? "") : "";
}

export function toastDetails(warning: AppWarning): AppNotice["details"] {
  return isNotice(warning) ? warning.details : undefined;
}

export function isError(
  warning: AppWarning,
  labels: Pick<WarningToastsLabels, "errorLabel">,
): boolean {
  if (isNotice(warning)) return warning.severity === "error";
  return (
    warning.startsWith(`${labels.errorLabel}:`) ||
    /\b4\d\d\b|error|失败|failed/i.test(warning)
  );
}

/** Stable content identity used to reconcile duplicate warning instances. */
export function warningKey(warning: AppWarning): string {
  if (!isNotice(warning)) return `text:${warning}`;
  return `notice:${warning.severity}:${warning.title}:${warning.message ?? ""}:${JSON.stringify(warning.details ?? [])}`;
}

export function formatWarningForCopy(
  warning: AppWarning,
  diagnosticsLabel: string,
): string {
  if (!isNotice(warning)) return warning;
  const lines = [warning.title];
  if (warning.message) lines.push(warning.message);
  const details = warning.details ?? [];
  if (details.length > 0) {
    lines.push("", `${diagnosticsLabel}:`);
    for (const detail of details) {
      lines.push(`${detail.label}: ${detail.value}`);
    }
  }
  return lines.join("\n");
}

type ToastPhase = "enter" | "enter-to" | "idle" | "leave" | "leave-to";

interface ToastItem {
  id: number;
  key: string;
  warning: AppWarning;
  detailsOpen: boolean;
  copied: boolean;
  phase: ToastPhase;
}

interface ToastTimer {
  handle: ReturnType<typeof setTimeout> | null;
  deadline: number;
  remaining: number;
}

interface TransitionTimer {
  frame: number | null;
  fallback: ReturnType<typeof setTimeout> | null;
  done: ReturnType<typeof setTimeout>;
}

const TRANSITION_MS = 220;

function isLeaving(item: ToastItem): boolean {
  return item.phase === "leave" || item.phase === "leave-to";
}

function toastDuration(
  warning: AppWarning,
  labels: Pick<WarningToastsLabels, "errorLabel">,
): number {
  const base = isError(warning, labels) ? 12000 : 6000;
  // Touch screens have no hover-to-pause, so grant extra reading time.
  const touch =
    typeof window !== "undefined" &&
    window.matchMedia?.("(hover: none)").matches === true;
  return touch ? base + 5000 : base;
}

function warningSignature(warnings: AppWarning[]): string {
  return JSON.stringify(warnings.map(warningKey));
}

function transitionClass(phase: ToastPhase): string {
  switch (phase) {
    case "enter":
      return "toast-enter-active toast-enter-from";
    case "enter-to":
      return "toast-enter-active";
    case "leave":
      return "toast-leave-active";
    case "leave-to":
      return "toast-leave-active toast-leave-to";
    default:
      return "";
  }
}

function StatusIcon({ name }: { name: IconName }): React.ReactElement {
  return (
    <span
      dangerouslySetInnerHTML={{ __html: iconSvg(name, "md") }}
      aria-hidden="true"
    />
  );
}

interface ToastPrimitiveProps {
  variant: "warning" | "danger";
  title: string;
  message: string;
  dismissLabel: string;
  onDismiss: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  children?: React.ReactNode;
}

function ToastPrimitive({
  variant,
  title,
  message,
  dismissLabel,
  onDismiss,
  onPointerEnter,
  onPointerLeave,
  children,
}: ToastPrimitiveProps): React.ReactElement {
  return (
    <div
      className={`ui-toast ui-toast--${variant}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <span className="ui-toast__icon" aria-hidden="true">
        <StatusIcon name={variant === "danger" ? "close" : "alert-triangle"} />
      </span>
      <div className="ui-toast__body">
        <div className="ui-toast__title">{title}</div>
        {message ? <div className="ui-toast__msg">{message}</div> : null}
        {children}
      </div>
      <button
        type="button"
        className="ui-icon-button ui-icon-button--sm ui-toast__close"
        aria-label={dismissLabel}
        onClick={onDismiss}
      >
        <StatusIcon name="close" />
      </button>
    </div>
  );
}

/**
 * React warning/error toast stack. State and reconciliation stay local so each
 * duplicate warning receives an independent id, timer, details state, and
 * dismissal index while the Vue host continues to own the app warning store.
 */
export function WarningToasts({
  warnings,
  labels,
  onDismiss,
}: WarningToastsProps): React.ReactElement {
  const nextId = useRef(1);
  const itemsRef = useRef<ToastItem[]>([]);
  const timers = useRef(new Map<number, ToastTimer>());
  const copiedTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const transitions = useRef(new Map<number, TransitionTimer>());
  const mounted = useRef(false);
  const dismissRef = useRef<(id: number) => void>(() => undefined);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const [items, setItems] = useState<ToastItem[]>(() => {
    const initial = warnings.map(
      (warning): ToastItem => ({
        id: nextId.current++,
        key: warningKey(warning),
        warning,
        detailsOpen: false,
        copied: false,
        phase: "enter",
      }),
    );
    itemsRef.current = initial;
    return initial;
  });

  function updateItems(updater: (previous: ToastItem[]) => ToastItem[]): void {
    setItems((previous) => {
      const next = updater(previous);
      itemsRef.current = next;
      return next;
    });
  }

  function clearTimer(id: number): void {
    const entry = timers.current.get(id);
    if (entry?.handle !== null && entry !== undefined) {
      clearTimeout(entry.handle);
    }
    timers.current.delete(id);
  }

  function clearCopiedTimer(id: number): void {
    const handle = copiedTimers.current.get(id);
    if (handle !== undefined) clearTimeout(handle);
    copiedTimers.current.delete(id);
  }

  function runTimer(id: number, ms: number): void {
    const previous = timers.current.get(id);
    if (previous?.handle !== null && previous !== undefined) {
      clearTimeout(previous.handle);
    }
    const entry: ToastTimer = {
      handle: setTimeout(() => dismissRef.current(id), ms),
      deadline: Date.now() + ms,
      remaining: ms,
    };
    timers.current.set(id, entry);
  }

  function pauseTimer(id: number): void {
    const entry = timers.current.get(id);
    if (entry === undefined || entry.handle === null) return;
    clearTimeout(entry.handle);
    entry.handle = null;
    entry.remaining = Math.max(0, entry.deadline - Date.now());
  }

  function resumeTimer(id: number): void {
    const toast = itemsRef.current.find((item) => item.id === id);
    if (toast === undefined || toast.detailsOpen || isLeaving(toast)) return;
    const entry = timers.current.get(id);
    if (entry === undefined || entry.handle !== null) return;
    runTimer(id, entry.remaining);
  }

  function cancelTransition(id: number): void {
    const transition = transitions.current.get(id);
    if (transition === undefined) return;
    if (
      transition.frame !== null &&
      typeof cancelAnimationFrame === "function"
    ) {
      cancelAnimationFrame(transition.frame);
    }
    if (transition.fallback !== null) clearTimeout(transition.fallback);
    clearTimeout(transition.done);
    transitions.current.delete(id);
  }

  function startEnter(id: number): void {
    if (transitions.current.has(id)) return;
    const toEntered = (): void => {
      updateItems((previous) =>
        previous.map((item) =>
          item.id === id && item.phase === "enter"
            ? { ...item, phase: "enter-to" }
            : item,
        ),
      );
    };
    const frame =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(toEntered)
        : null;
    const fallback = frame === null ? setTimeout(toEntered, 0) : null;
    const done = setTimeout(() => {
      updateItems((previous) =>
        previous.map((item) =>
          item.id === id && item.phase === "enter-to"
            ? { ...item, phase: "idle" }
            : item,
        ),
      );
      transitions.current.delete(id);
    }, TRANSITION_MS);
    transitions.current.set(id, { frame, fallback, done });
  }

  function startLeave(id: number): void {
    // A toast can be dismissed or removed by reconciliation before its enter
    // frame completes. Replace that enter transition with a real leave timer
    // instead of leaving the instance stranded in local state.
    cancelTransition(id);
    const toLeaving = (): void => {
      updateItems((previous) =>
        previous.map((item) =>
          item.id === id && item.phase === "leave"
            ? { ...item, phase: "leave-to" }
            : item,
        ),
      );
    };
    const frame =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(toLeaving)
        : null;
    const fallback = frame === null ? setTimeout(toLeaving, 0) : null;
    const done = setTimeout(() => {
      updateItems((previous) => previous.filter((item) => item.id !== id));
      transitions.current.delete(id);
    }, TRANSITION_MS);
    transitions.current.set(id, { frame, fallback, done });
  }

  function dismissById(id: number): void {
    const active = itemsRef.current.filter((item) => !isLeaving(item));
    const index = active.findIndex((item) => item.id === id);
    if (index === -1) return;

    clearTimer(id);
    clearCopiedTimer(id);
    updateItems((previous) =>
      previous.map((item) =>
        item.id === id ? { ...item, phase: "leave" } : item,
      ),
    );
    // Emit immediately, while the local order still matches the rendered
    // stack. The leave transition is local and does not delay app state.
    onDismissRef.current(index);
    startLeave(id);
  }
  dismissRef.current = dismissById;

  function toggleDetails(id: number): void {
    const toast = itemsRef.current.find((item) => item.id === id);
    if (toast === undefined || isLeaving(toast)) return;
    const open = !toast.detailsOpen;
    updateItems((previous) =>
      previous.map((item) =>
        item.id === id ? { ...item, detailsOpen: open } : item,
      ),
    );
    if (open) pauseTimer(id);
    else resumeTimer(id);
  }

  async function copyDetails(id: number): Promise<void> {
    const toast = itemsRef.current.find((item) => item.id === id);
    if (toast === undefined || isLeaving(toast)) return;
    const ok = await copyTextToClipboard(
      formatWarningForCopy(toast.warning, labels.diagnostics),
    );
    if (!ok || !mounted.current) return;
    clearCopiedTimer(id);
    updateItems((previous) =>
      previous.map((item) =>
        item.id === id ? { ...item, copied: true } : item,
      ),
    );
    const handle = setTimeout(() => {
      updateItems((previous) =>
        previous.map((item) =>
          item.id === id ? { ...item, copied: false } : item,
        ),
      );
      copiedTimers.current.delete(id);
    }, 1400);
    copiedTimers.current.set(id, handle);
  }

  function reconcile(nextWarnings: AppWarning[]): void {
    const current = itemsRef.current;
    const active = current.filter((item) => !isLeaving(item));
    const unmatched = [...active];
    const nextActive: ToastItem[] = [];

    for (const warning of nextWarnings) {
      const key = warningKey(warning);
      const at = unmatched.findIndex((item) => item.key === key);
      const reused = at === -1 ? undefined : unmatched.splice(at, 1)[0];
      if (reused !== undefined) {
        nextActive.push({ ...reused, warning, key });
        continue;
      }
      const item: ToastItem = {
        id: nextId.current++,
        key,
        warning,
        detailsOpen: false,
        copied: false,
        phase: "enter",
      };
      nextActive.push(item);
    }

    const alreadyLeaving = current.filter(isLeaving);
    const gone = unmatched.map((item) => ({
      ...item,
      phase: "leave" as const,
    }));
    updateItems(() => [...nextActive, ...alreadyLeaving, ...gone]);

    for (const item of nextActive) {
      if (!timers.current.has(item.id)) {
        runTimer(item.id, toastDuration(item.warning, labels));
      }
      if (item.phase === "enter") startEnter(item.id);
    }
    for (const item of gone) {
      clearTimer(item.id);
      clearCopiedTimer(item.id);
      startLeave(item.id);
    }
  }

  const signature = warningSignature(warnings);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      timers.current.forEach((entry) => {
        if (entry.handle !== null) clearTimeout(entry.handle);
      });
      timers.current.clear();
      copiedTimers.current.forEach((entry) => clearTimeout(entry));
      copiedTimers.current.clear();
      transitions.current.forEach((entry) => {
        if (
          entry.frame !== null &&
          typeof cancelAnimationFrame === "function"
        ) {
          cancelAnimationFrame(entry.frame);
        }
        if (entry.fallback !== null) clearTimeout(entry.fallback);
        clearTimeout(entry.done);
      });
      transitions.current.clear();
    };
  }, []);

  useEffect(() => {
    reconcile(warnings);
  }, [signature]);

  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((toast) => {
        const details = toastDetails(toast.warning);
        const variant = isError(toast.warning, labels) ? "danger" : "warning";
        return (
          <div
            key={toast.id}
            className={`toast-item toast-move ${transitionClass(toast.phase)}`.trim()}
          >
            <ToastPrimitive
              variant={variant}
              title={toastTitle(toast.warning)}
              message={toastMessage(toast.warning)}
              dismissLabel={labels.dismiss}
              onDismiss={() => dismissById(toast.id)}
              onPointerEnter={() => pauseTimer(toast.id)}
              onPointerLeave={() => resumeTimer(toast.id)}
            >
              {details?.length ? (
                <div className="actions">
                  <button
                    className="link"
                    type="button"
                    aria-expanded={toast.detailsOpen}
                    onClick={() => toggleDetails(toast.id)}
                  >
                    {toast.detailsOpen
                      ? labels.hideDetails
                      : labels.showDetails}
                  </button>
                  <button
                    className="link"
                    type="button"
                    onClick={() => void copyDetails(toast.id)}
                  >
                    {toast.copied ? labels.copied : labels.copyDetails}
                  </button>
                </div>
              ) : null}
              {toast.detailsOpen && details?.length ? (
                <dl className="details">
                  {details.map((detail, index) => (
                    <div
                      key={`${detail.label}:${detail.value}:${index}`}
                      className="detail-row"
                    >
                      <dt>{detail.label}</dt>
                      <dd>{detail.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </ToastPrimitive>
          </div>
        );
      })}
    </div>
  );
}
