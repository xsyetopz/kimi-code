import {
  type Component,
  Container,
  isFocusable,
  type OverlayHandle,
  type OverlayOptions,
} from "./contracts.ts";
import type {
  BlockedOverlayFocusRestoreState,
  OverlayFocusRestorePolicy,
  OverlayFocusRestoreState,
  OverlayStackEntry,
} from "./overlay-shared.ts";
import type { TUI } from "./tui-class.ts";

export function setFocusInternal(
  this: TUI,
  {
    component,
    overlayFocusRestore,
  }: {
    component: Component | null;
    overlayFocusRestore: OverlayFocusRestorePolicy;
  },
): void {
  const previousFocus = this.focusedComponent;
  let nextFocus = component;
  const previousFocusedOverlay = previousFocus
    ? this.overlayStack.find(
        (entry) =>
          entry.component === previousFocus && this.isOverlayVisible(entry),
      )
    : undefined;
  const nextFocusIsOverlay = nextFocus
    ? this.overlayStack.some((entry) => entry.component === nextFocus)
    : false;
  const restoreState = this.getVisibleOverlayFocusRestore();
  if (nextFocus && !nextFocusIsOverlay) {
    if (
      restoreState.status === "blocked" &&
      restoreState.blockedBy === previousFocus
    ) {
      if (
        restoreState.resume.status === "focus-target" ||
        !this.isComponentMounted(restoreState.blockedBy)
      ) {
        nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
      } else {
        this.overlayFocusRestore = {
          status: "blocked",
          overlay: restoreState.overlay,
          blockedBy: nextFocus,
          resume: restoreState.resume,
        };
      }
    } else if (
      previousFocusedOverlay &&
      restoreState.status !== "inactive" &&
      restoreState.overlay === previousFocusedOverlay &&
      !this.isOverlayFocusAncestor(previousFocusedOverlay, nextFocus)
    ) {
      this.overlayFocusRestore = {
        status: "blocked",
        overlay: previousFocusedOverlay,
        blockedBy: nextFocus,
        resume: { status: "restore-overlay" },
      };
    }
  } else if (nextFocus === null) {
    if (
      restoreState.status === "blocked" &&
      restoreState.blockedBy === previousFocus
    ) {
      nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
    } else if (overlayFocusRestore === "clear") {
      this.clearOverlayFocusRestore();
    }
  }

  if (isFocusable(this.focusedComponent)) {
    this.focusedComponent.focused = false;
  }

  this.focusedComponent = nextFocus;

  if (isFocusable(nextFocus)) {
    nextFocus.focused = true;
  }

  const focusedOverlay = nextFocus
    ? this.overlayStack.find(
        (entry) =>
          entry.component === nextFocus && this.isOverlayVisible(entry),
      )
    : undefined;
  if (focusedOverlay) {
    this.overlayFocusRestore = {
      status: "eligible",
      overlay: focusedOverlay,
    };
  }
}

export function clearOverlayFocusRestore(this: TUI): void {
  this.overlayFocusRestore = { status: "inactive" };
}

export function clearOverlayFocusRestoreFor(
  this: TUI,
  overlay: OverlayStackEntry,
): void {
  if (
    this.overlayFocusRestore.status !== "inactive" &&
    this.overlayFocusRestore.overlay === overlay
  ) {
    this.clearOverlayFocusRestore();
  }
}

export function resolveBlockedOverlayFocusResume(
  this: TUI,
  restoreState: BlockedOverlayFocusRestoreState,
): Component | null {
  if (restoreState.resume.status === "restore-overlay")
    return restoreState.overlay.component;
  this.clearOverlayFocusRestore();
  return restoreState.resume.target;
}

export function getVisibleOverlayFocusRestore(
  this: TUI,
): OverlayFocusRestoreState {
  const restoreState = this.overlayFocusRestore;
  if (restoreState.status === "inactive") return restoreState;
  if (
    !(
      this.overlayStack.includes(restoreState.overlay) &&
      this.isOverlayVisible(restoreState.overlay)
    )
  ) {
    return { status: "inactive" };
  }
  return restoreState;
}

export function isOverlayFocusAncestor(
  this: TUI,
  entry: OverlayStackEntry,
  component: Component,
): boolean {
  const visited = new Set<Component>();
  let current = entry.preFocus;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (current === component) return true;
    current =
      this.overlayStack.find((overlay) => overlay.component === current)
        ?.preFocus ?? null;
  }
  return false;
}

export function retargetOverlayPreFocus(
  this: TUI,
  removed: OverlayStackEntry,
): void {
  for (const overlay of this.overlayStack) {
    if (overlay !== removed && overlay.preFocus === removed.component) {
      overlay.preFocus = removed.preFocus;
    }
  }
}

export function isComponentMounted(this: TUI, component: Component): boolean {
  return this.children.some((child) =>
    this.containsComponent(child, component),
  );
}

export function containsComponent(
  this: TUI,
  root: Component,
  target: Component,
): boolean {
  if (root === target) return true;
  if (!(root instanceof Container)) return false;
  return root.children.some((child) => this.containsComponent(child, target));
}

export function showOverlay(
  this: TUI,
  component: Component,
  options?: OverlayOptions,
): OverlayHandle {
  const entry: OverlayStackEntry = {
    component,
    ...(options === undefined ? {} : { options }),
    preFocus: this.focusedComponent,
    hidden: false,
    focusOrder: ++this.focusOrderCounter,
  };
  this.overlayStack.push(entry);
  // Only focus if overlay is actually visible
  if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
    this.setFocus(component);
  }
  this.terminal.hideCursor();
  this.requestRender();

  // Return handle for controlling this overlay
  return {
    hide: () => {
      const index = this.overlayStack.indexOf(entry);
      if (index !== -1) {
        this.clearOverlayFocusRestoreFor(entry);
        this.retargetOverlayPreFocus(entry);
        this.overlayStack.splice(index, 1);
        // Restore focus if this overlay had focus
        if (this.focusedComponent === component) {
          const topVisible = this.getTopmostVisibleOverlay();
          this.setFocus(topVisible?.component ?? entry.preFocus);
        }
        if (this.overlayStack.length === 0) this.terminal.hideCursor();
        this.requestRender();
      }
    },
    setHidden: (hidden: boolean) => {
      if (entry.hidden === hidden) return;
      entry.hidden = hidden;
      // Update focus when hiding/showing
      if (hidden) {
        this.clearOverlayFocusRestoreFor(entry);
        // If this overlay had focus, move focus to next visible or preFocus
        if (this.focusedComponent === component) {
          const topVisible = this.getTopmostVisibleOverlay();
          this.setFocus(topVisible?.component ?? entry.preFocus);
        }
      } else {
        // Restore focus to this overlay when showing (if it's actually visible)
        if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
          entry.focusOrder = ++this.focusOrderCounter;
          this.setFocus(component);
        }
      }
      this.requestRender();
    },
    isHidden: () => entry.hidden,
    focus: () => {
      if (!(this.overlayStack.includes(entry) && this.isOverlayVisible(entry)))
        return;
      entry.focusOrder = ++this.focusOrderCounter;
      this.setFocus(component);
      this.requestRender();
    },
    unfocus: (unfocusOptions) => {
      const isFocused = this.focusedComponent === component;
      const restoreState = this.overlayFocusRestore;
      const hasPendingRestore =
        restoreState.status !== "inactive" && restoreState.overlay === entry;
      if (!(isFocused || hasPendingRestore)) return;
      if (
        restoreState.status === "blocked" &&
        restoreState.overlay === entry &&
        this.focusedComponent === restoreState.blockedBy
      ) {
        if (unfocusOptions) {
          this.overlayFocusRestore = {
            status: "blocked",
            overlay: entry,
            blockedBy: restoreState.blockedBy,
            resume: { status: "focus-target", target: unfocusOptions.target },
          };
        } else {
          this.clearOverlayFocusRestore();
        }
        this.requestRender();
        return;
      }
      this.clearOverlayFocusRestoreFor(entry);
      if (isFocused || unfocusOptions) {
        const topVisible = this.getTopmostVisibleOverlay();
        const fallbackTarget =
          topVisible && topVisible !== entry
            ? topVisible.component
            : entry.preFocus;
        this.setFocus(unfocusOptions ? unfocusOptions.target : fallbackTarget);
      }
      this.requestRender();
    },
    isFocused: () => this.focusedComponent === component,
  };
}

export function hideOverlay(this: TUI): void {
  const overlay = this.overlayStack.at(-1);
  if (!overlay) return;
  this.clearOverlayFocusRestoreFor(overlay);
  this.retargetOverlayPreFocus(overlay);
  this.overlayStack.pop();
  if (this.focusedComponent === overlay.component) {
    // Find topmost visible overlay, or fall back to preFocus
    const topVisible = this.getTopmostVisibleOverlay();
    this.setFocus(topVisible?.component ?? overlay.preFocus);
  }
  if (this.overlayStack.length === 0) this.terminal.hideCursor();
  this.requestRender();
}

export function hasOverlay(this: TUI): boolean {
  return this.overlayStack.some((o) => this.isOverlayVisible(o));
}

export function isOverlayVisible(this: TUI, entry: OverlayStackEntry): boolean {
  if (entry.hidden) return false;
  if (entry.options?.visible) {
    return entry.options.visible(this.terminal.columns, this.terminal.rows);
  }
  return true;
}

export function getTopmostVisibleOverlay(
  this: TUI,
): OverlayStackEntry | undefined {
  let topmost: OverlayStackEntry | undefined;
  for (const overlay of this.overlayStack) {
    if (overlay.options?.nonCapturing || !this.isOverlayVisible(overlay))
      continue;
    if (!topmost || overlay.focusOrder > topmost.focusOrder) {
      topmost = overlay;
    }
  }
  return topmost;
}
