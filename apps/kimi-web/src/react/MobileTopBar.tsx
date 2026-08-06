import { iconSvg } from "../lib/icons";
import type { WorkspaceView } from "../types";

/**
 * The translated labels are supplied by the Vue host while the app is being
 * migrated. Keeping translation lookup at the boundary means this component
 * does not need to depend on vue-i18n and can move with the React shell later.
 */
export interface MobileTopBarLabels {
  openSwitcher: string;
  openSettings: string;
  noWorkspace: string;
  running: string;
  idle: string;
  sessionCount: string;
}

export interface MobileTopBarProps {
  /** Active workspace (for the chip glyph and path label). */
  workspace: WorkspaceView | null;
  /** Active session title (the bold right side of the mono path). */
  sessionTitle?: string;
  /** True when the active session is doing work. */
  running?: boolean;
  /** Current git branch shown on the status sub-line. */
  branch?: string;
  /** Number of sessions in the active workspace. */
  sessionCount?: number;
  /** Localized labels from the app's current locale. */
  labels: MobileTopBarLabels;
  onOpenSwitcher: () => void;
  onOpenSettings: () => void;
}

function RegisteredIcon({
  name,
  size = "lg",
}: {
  name: "sliders";
  size?: "sm" | "md" | "lg";
}): React.ReactElement {
  return (
    <span
      className="mobile-topbar__icon"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: iconSvg(name, size) }}
    />
  );
}

/**
 * Mobile title bar. The shell owns only mobile navigation chrome; sheet state
 * and all session/workspace state remain in the existing app host.
 */
export function MobileTopBar({
  workspace,
  sessionTitle = "",
  running = false,
  branch = "",
  sessionCount = 0,
  labels,
  onOpenSwitcher,
  onOpenSettings,
}: MobileTopBarProps): React.ReactElement {
  const source = (workspace?.name || workspace?.root || "").trim();
  const chip = source.charAt(0).toUpperCase() || "K";
  const workspaceName = workspace?.name ?? labels.noWorkspace;
  const statusText = running ? labels.running : labels.idle;

  return (
    <div className="mobile-topbar">
      <span className="mobile-topbar__workspace-chip">{chip}</span>

      <button
        type="button"
        className="mobile-topbar__middle"
        aria-label={labels.openSwitcher}
        onClick={onOpenSwitcher}
      >
        <span className="mobile-topbar__path">
          <span className="mobile-topbar__workspace-name">{workspaceName}</span>
          {sessionTitle ? (
            <>
              <span className="mobile-topbar__separator">/</span>
              <span className="mobile-topbar__session">{sessionTitle}</span>
            </>
          ) : null}
          <span className="mobile-topbar__chevron" aria-hidden="true">
            ⌄
          </span>
        </span>
        <span className="mobile-topbar__status">
          <span
            className={`mobile-topbar__status-dot${running ? " is-running" : ""}`}
            aria-hidden="true"
          />
          <span>{statusText}</span>
          {branch ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{branch}</span>
            </>
          ) : null}
          {sessionCount > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{labels.sessionCount}</span>
            </>
          ) : null}
        </span>
      </button>

      <button
        type="button"
        className="mobile-topbar__settings"
        aria-label={labels.openSettings}
        onClick={onOpenSettings}
      >
        <RegisteredIcon name="sliders" size="lg" />
      </button>
    </div>
  );
}

