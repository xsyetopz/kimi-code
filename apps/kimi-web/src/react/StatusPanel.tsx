import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ThinkingLevel } from "../api/types";
import type { ConversationStatus, PermissionMode } from "../types";
import { formatTokens } from "../lib/formatTokens";
import { iconSvg } from "../lib/icons";

import "./StatusPanel.css";

/** Localized copy supplied by the Vue host while the shell is migrating. */
export interface StatusPanelLabels {
  title: string;
  close: string;
  model: string;
  thinking: string;
  permission: string;
  planMode: string;
  swarmMode: string;
  context: string;
  cost: string;
  contextValue: (used: string, max: string, pct: number) => string;
  none: string;
  permissionManual: string;
  permissionAuto: string;
  permissionYolo: string;
  planOn: string;
  planOff: string;
  swarmOn: string;
  swarmOff: string;
}

export interface StatusPanelProps {
  status: ConversationStatus;
  thinking: ThinkingLevel;
  planMode: boolean;
  swarmMode?: boolean;
  /** Cumulative session cost in USD, when known (>= 0). */
  costUsd?: number;
  labels: StatusPanelLabels;
  onClose: () => void;
}

/** Context usage percentage: ceil so a non-zero sliver remains visible. */
export function statusContextPercent(value: Pick<ConversationStatus, "ctxUsed" | "ctxMax">): number {
  if (value.ctxMax <= 0) return 0;
  return Math.min(100, Math.max(0, Math.ceil((value.ctxUsed / value.ctxMax) * 100)));
}

export function statusPermissionLabel(
  permission: PermissionMode,
  labels: Pick<
    StatusPanelLabels,
    "permissionManual" | "permissionAuto" | "permissionYolo"
  >,
): string {
  if (permission === "yolo") return labels.permissionYolo;
  if (permission === "auto") return labels.permissionAuto;
  return labels.permissionManual;
}

export function statusCostText(costUsd: number | undefined, none: string): string {
  return typeof costUsd === "number" && costUsd > 0
    ? `$${costUsd.toFixed(4)}`
    : none;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface StatusDialogProps {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * The React equivalent of the design-system Dialog primitive used by the
 * legacy panel. It deliberately keeps the same overlay, close-button, Esc,
 * focus-trap, and focus-restore semantics while rendering through a portal.
 */
function StatusDialog({
  title,
  closeLabel,
  onClose,
  children,
}: StatusDialogProps): React.ReactElement | null {
  const [open, setOpen] = useState(true);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);
  const closing = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const requestClose = (): void => {
    if (!open || closing.current) return;
    closing.current = true;
    setOpen(false);
    onCloseRef.current();
  };

  useEffect(() => {
    if (!open || typeof document === "undefined") return;

    previouslyFocused.current = document.activeElement;
    const panel = panelRef.current;
    const focusables = (): HTMLElement[] =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];

    const list = focusables();
    (list[0] ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;

      const current = focusables();
      const first = current[0];
      const last = current[current.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panel?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
        previouslyFocused.current = null;
      }
    };
  }, [open]);

  if (!open) return null;

  const content = (
    <div
      className="status-dialog__overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={panelRef}
        className="status-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="status-dialog-title"
        tabIndex={-1}
      >
        <div className="status-dialog__head">
          <div className="status-dialog__titles">
            <div id="status-dialog-title" className="status-dialog__title">
              {title}
            </div>
          </div>
          <button
            type="button"
            className="status-dialog__close"
            aria-label={closeLabel}
            onClick={requestClose}
          >
            <span
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: iconSvg("close", "md") }}
            />
          </button>
        </div>
        <div className="status-dialog__body">{children}</div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? content : createPortal(content, document.body);
}

function permissionClass(permission: PermissionMode): string {
  return `status-panel__value--permission-${permission}`;
}

/** Session status overlay used by the /status command. */
export function StatusPanel({
  status,
  thinking,
  planMode,
  swarmMode = false,
  costUsd,
  labels,
  onClose,
}: StatusPanelProps): React.ReactElement {
  const pct = statusContextPercent(status);
  const contextValue =
    status.ctxMax > 0
      ? labels.contextValue(
          formatTokens(status.ctxUsed),
          formatTokens(status.ctxMax),
          pct,
        )
      : labels.none;
  const permission = statusPermissionLabel(status.permission, labels);
  const cost = statusCostText(costUsd, labels.none);

  return (
    <StatusDialog title={labels.title} closeLabel={labels.close} onClose={onClose}>
      <dl className="status-panel__rows">
        <div className="status-panel__row">
          <dt>{labels.model}</dt>
          <dd>{status.model}</dd>
        </div>
        <div className="status-panel__row">
          <dt>{labels.thinking}</dt>
          <dd>{thinking}</dd>
        </div>
        <div className="status-panel__row">
          <dt>{labels.permission}</dt>
          <dd className={`status-panel__value ${permissionClass(status.permission)}`}>
            {permission}
          </dd>
        </div>
        <div className="status-panel__row">
          <dt>{labels.planMode}</dt>
          <dd className={planMode ? "status-panel__value status-panel__value--on" : "status-panel__value"}>
            {planMode ? labels.planOn : labels.planOff}
          </dd>
        </div>
        <div className="status-panel__row">
          <dt>{labels.swarmMode}</dt>
          <dd className={swarmMode ? "status-panel__value status-panel__value--on" : "status-panel__value"}>
            {swarmMode ? labels.swarmOn : labels.swarmOff}
          </dd>
        </div>
        <div className="status-panel__row">
          <dt>{labels.context}</dt>
          <dd>
            <span className="status-panel__context-text">{contextValue}</span>
            {status.ctxMax > 0 ? (
              <span className="status-panel__bar" aria-label={`${pct}%`}>
                <i style={{ width: `${pct}%` }} />
              </span>
            ) : null}
          </dd>
        </div>
        <div className="status-panel__row">
          <dt>{labels.cost}</dt>
          <dd>{cost}</dd>
        </div>
      </dl>
    </StatusDialog>
  );
}
