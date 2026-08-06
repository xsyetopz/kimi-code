import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";

import { safeGetString, safeSetString } from "../lib/storage";

import "./ResizeHandle.css";

export interface ResizeHandleProps {
  /** localStorage key used to persist the selected width. */
  storageKey: string;
  /** Width used when no valid persisted value exists. */
  defaultWidth: number;
  /** Smallest allowed width in pixels. */
  min: number;
  /** Largest allowed width in pixels. */
  max: number;
  /** Reverse the horizontal drag direction (used by the right panel). */
  reverse?: boolean;
  /** Accessible label supplied by the Vue host's current locale. */
  ariaLabel?: string;
  /** Width changes are translated to Vue's `update:width` event by the host. */
  onWidthChange: (width: number) => void;
  /** Drag state changes are translated to Vue's `update:dragging` event. */
  onDraggingChange: (dragging: boolean) => void;
  /** Optional class for direct React consumers; the Vue host keeps its grid class. */
  className?: string;
}

export interface ResizeClampOptions {
  defaultWidth: number;
  min: number;
  max: number;
}

/**
 * Keep the resize arithmetic explicit and independently testable. This mirrors
 * the old `useResizable` contract: invalid values fall back to the default,
 * valid values are rounded, and the result is bounded by the current cap.
 */
export function clampResizeWidth(
  value: number,
  { defaultWidth, min, max }: ResizeClampOptions,
): number {
  if (!Number.isFinite(value)) return defaultWidth;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readStoredWidth(key: string): number | null {
  try {
    const raw = safeGetString(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStoredWidth(key: string, value: number): void {
  try {
    safeSetString(key, String(value));
  } catch {
    // localStorage can be unavailable (for example in private browsing).
  }
}

interface ResizeOptions {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  reverse: boolean;
  onWidthChange: (width: number) => void;
  onDraggingChange: (dragging: boolean) => void;
}

interface ActiveDrag {
  element: HTMLElement;
  pointerId: number;
  startX: number;
  startWidth: number;
}

/**
 * React equivalent of the legacy `useResizable` composable. The hook keeps
 * state in React while the host remains responsible for translating callbacks
 * into the Vue parent's `update:*` events.
 */
function useResizable(options: ResizeOptions): {
  width: number;
  dragging: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
} {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const initialOptions = {
    defaultWidth: options.defaultWidth,
    min: options.min,
    max: options.max,
  };
  const [width, setWidthState] = useState(() =>
    clampResizeWidth(
      readStoredWidth(options.storageKey) ?? options.defaultWidth,
      initialOptions,
    ),
  );
  const [dragging, setDraggingState] = useState(false);
  const widthRef = useRef(width);
  const draggingRef = useRef(dragging);
  const activeDragRef = useRef<ActiveDrag | null>(null);

  widthRef.current = width;
  draggingRef.current = dragging;

  const clamp = useCallback((value: number): number => {
    const current = optionsRef.current;
    return clampResizeWidth(value, {
      defaultWidth: current.defaultWidth,
      min: current.min,
      max: current.max,
    });
  }, []);

  const setWidth = useCallback(
    (value: number): void => {
      const current = optionsRef.current;
      const next = clamp(value);
      widthRef.current = next;
      setWidthState(next);
      writeStoredWidth(current.storageKey, next);
    },
    [clamp],
  );

  const endDrag = useCallback((): void => {
    const active = activeDragRef.current;
    if (!active && !draggingRef.current) return;

    activeDragRef.current = null;
    draggingRef.current = false;
    setDraggingState(false);

    if (typeof document !== "undefined") {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", endDrag);
      document.removeEventListener("pointercancel", endDrag);
    }

    if (active) {
      try {
        active.element.releasePointerCapture(active.pointerId);
      } catch {
        // Pointer capture may already have been released by the browser.
      }
    }
  }, []);

  const onPointerMove = useCallback(
    (event: PointerEvent): void => {
      const active = activeDragRef.current;
      if (!active || !draggingRef.current) return;
      const delta = event.clientX - active.startX;
      const direction = optionsRef.current.reverse ? -1 : 1;
      setWidth(active.startWidth + direction * delta);
    },
    [setWidth],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      event.preventDefault();
      // A second pointerdown should not leave listeners from a prior drag
      // attached. In normal use this is a no-op because only one pointer owns
      // the handle, but it also makes touch cancellation deterministic.
      if (activeDragRef.current) endDrag();

      const element = event.currentTarget;
      const current = optionsRef.current;
      const active: ActiveDrag = {
        element,
        pointerId: event.pointerId,
        startX: event.clientX,
        // Clamp the starting width so a newly narrowed viewport responds to
        // the first movement immediately instead of covering an invisible gap.
        startWidth: clamp(widthRef.current),
      };
      activeDragRef.current = active;
      draggingRef.current = true;
      setDraggingState(true);

      if (typeof document !== "undefined") {
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";
        // Pointer capture keeps the handle receiving moves outside its 4px
        // strip. Document listeners provide the same global fallback as the
        // previous composable in browsers/test environments without capture.
        document.addEventListener("pointermove", onPointerMove);
        document.addEventListener("pointerup", endDrag);
        document.addEventListener("pointercancel", endDrag);
      }

      try {
        element.setPointerCapture(active.pointerId);
      } catch {
        // setPointerCapture is unavailable in some test environments.
      }

      // Keep the local `current` read above intentional: it ensures options
      // are captured at pointerdown, while `reverse` itself stays live through
      // optionsRef if the parent changes it during a drag.
      void current;
    },
    [clamp, endDrag, onPointerMove],
  );

  useEffect(() => {
    optionsRef.current.onWidthChange(width);
  }, [width]);

  useEffect(() => {
    optionsRef.current.onDraggingChange(dragging);
  }, [dragging]);

  useEffect(() => () => endDrag(), [endDrag]);

  return { width, dragging, onPointerDown };
}

export function ResizeHandle({
  storageKey,
  defaultWidth,
  min,
  max,
  reverse = false,
  ariaLabel = "Resize panel width",
  onWidthChange,
  onDraggingChange,
  className,
}: ResizeHandleProps): ReactElement {
  const { dragging, onPointerDown } = useResizable({
    storageKey,
    defaultWidth,
    min,
    max,
    reverse,
    onWidthChange,
    onDraggingChange,
  });

  return (
    <div
      className={["rh", dragging ? "dragging" : "", className]
        .filter(Boolean)
        .join(" ")}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
    >
      <span className="rh-bar" aria-hidden="true" />
    </div>
  );
}
