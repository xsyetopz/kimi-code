import {
  useEffect,
  useLayoutEffect,
  useRef,
  type UIEvent,
} from "react";

import { iconSvg } from "../lib/icons";
import "./ThinkingPanel.css";

export interface ThinkingPanelLabels {
  /** Shared right-side panel title (usually "Preview"). */
  preview: string;
  /** Default subtitle for the thinking transcript. */
  panelTitle: string;
  /** Accessible close-button label. */
  close: string;
}

export interface ThinkingPanelProps {
  /** Full thinking transcript; this may grow while the turn is streaming. */
  text: string;
  /** Header subtitle override, used by the compaction-summary viewer. */
  subtitle?: string;
  /** Localized labels supplied by the Vue host during the shell migration. */
  labels: ThinkingPanelLabels;
  /** Close the shared detail panel. */
  onClose: () => void;
}

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

const FOLLOW_THRESHOLD = 24;

/**
 * Keep this testable separately from the DOM effect. The Vue panel uses the
 * same strict `< 24px` threshold, so a user exactly 24px from the bottom is
 * considered to have intentionally scrolled away.
 */
export function isNearBottom(
  metrics: ScrollMetrics,
  threshold = FOLLOW_THRESHOLD,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < threshold;
}

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Full thinking transcript in the shared right-side detail slot. The host owns
 * localization and state; this component owns the rendered panel and keeps a
 * near-bottom reader following streaming text without hijacking an upward
 * scroll.
 */
export function ThinkingPanel({
  text,
  subtitle,
  labels,
  onClose,
}: ThinkingPanelProps): React.ReactElement {
  const bodyRef = useRef<HTMLPreElement | null>(null);
  // This is intentionally updated from scroll events instead of deriving from
  // the post-render scrollHeight. A streaming append increases scrollHeight,
  // so checking only after React commits would incorrectly classify a reader
  // who was at the bottom before the append as having scrolled up.
  const shouldFollowRef = useRef(true);

  useIsomorphicLayoutEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;

    if (shouldFollowRef.current) {
      body.scrollTop = body.scrollHeight;
    }
    shouldFollowRef.current = isNearBottom(body);
  }, [text]);

  function onBodyScroll(event: UIEvent<HTMLPreElement>): void {
    shouldFollowRef.current = isNearBottom(event.currentTarget);
  }

  const resolvedSubtitle = subtitle ?? labels.panelTitle;

  return (
    <div className="thinking-panel">
      <div className="thinking-panel__header">
        <span className="thinking-panel__title">{labels.preview}</span>
        {resolvedSubtitle ? (
          <span className="thinking-panel__subtitle" title={resolvedSubtitle}>
            {resolvedSubtitle}
          </span>
        ) : null}
        <button
          type="button"
          className="thinking-panel__close"
          aria-label={labels.close}
          onClick={onClose}
        >
          <span
            className="thinking-panel__close-icon"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: iconSvg("close", "sm") }}
          />
        </button>
      </div>
      <pre
        ref={bodyRef}
        className="thinking-panel__body"
        onScroll={onBodyScroll}
      >
        {text}
      </pre>
    </div>
  );
}
