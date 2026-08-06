import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/icons", () => ({
  iconSvg: (name: string, size: string) =>
    `<svg data-icon="${name}" data-size="${size}"></svg>`,
}));

import type { WorkspaceView } from "../types";
import { MobileTopBar, type MobileTopBarLabels } from "./MobileTopBar";

const labels: MobileTopBarLabels = {
  openSwitcher: "Switch session / workspace",
  openSettings: "Session settings",
  noWorkspace: "No workspace",
  running: "running",
  idle: "idle",
  sessionCount: "3 sessions",
};

const workspace: WorkspaceView = {
  id: "workspace-1",
  name: "kimi-code",
  root: "/work/kimi-code",
  shortPath: "~/work/kimi-code",
  sessionCount: 3,
};

describe("MobileTopBar", () => {
  it("renders workspace/session identity and live status details", () => {
    const html = renderToStaticMarkup(
      <MobileTopBar
        workspace={workspace}
        sessionTitle="Refactor shell"
        running
        branch="main"
        sessionCount={3}
        labels={labels}
        onOpenSwitcher={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    expect(html).toContain('class="mobile-topbar__workspace-chip">K</span>');
    expect(html).toContain("kimi-code");
    expect(html).toContain("Refactor shell");
    expect(html).toContain("running");
    expect(html).toContain("main");
    expect(html).toContain("3 sessions");
    expect(html).toContain('aria-label="Switch session / workspace"');
    expect(html).toContain('aria-label="Session settings"');
    expect(html).toContain('data-icon="sliders"');
    expect(html).toContain("is-running");
  });

  it("falls back to the default chip and omits optional details when absent", () => {
    const html = renderToStaticMarkup(
      <MobileTopBar
        workspace={null}
        labels={labels}
        onOpenSwitcher={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    expect(html).toContain('class="mobile-topbar__workspace-chip">K</span>');
    expect(html).toContain("No workspace");
    expect(html).toContain("idle");
    expect(html).not.toContain("3 sessions");
    expect(html).not.toContain("is-running");
  });
});

