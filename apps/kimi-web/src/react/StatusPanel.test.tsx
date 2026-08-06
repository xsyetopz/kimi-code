import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/icons", () => ({
  iconSvg: (name: string, size: string) =>
    `<svg data-icon="${name}" data-size="${size}"></svg>`,
}));

import type { ConversationStatus } from "../types";
import {
  StatusPanel,
  statusContextPercent,
  statusCostText,
  type StatusPanelLabels,
} from "./StatusPanel";

const labels: StatusPanelLabels = {
  title: "Session status",
  close: "Close",
  model: "Model",
  thinking: "Thinking",
  permission: "Permission",
  planMode: "Plan mode",
  swarmMode: "Swarm mode",
  context: "Context",
  cost: "Cost",
  contextValue: (used, max, pct) => `${used} / ${max} (${pct}%)`,
  none: "—",
  permissionManual: "Manual",
  permissionAuto: "Auto",
  permissionYolo: "YOLO",
  planOn: "on",
  planOff: "off",
  swarmOn: "on",
  swarmOff: "off",
};

const status: ConversationStatus = {
  model: "Kimi K2",
  modelId: "kimi-k2",
  ctxUsed: 513,
  ctxMax: 1024,
  permission: "auto",
  branch: "main",
  cwd: "/tmp/project",
  isGitRepo: true,
};

describe("StatusPanel", () => {
  it("renders the current status rows and a ceil-based context bar", () => {
    const html = renderToStaticMarkup(
      <StatusPanel
        status={status}
        thinking="high"
        planMode
        swarmMode
        costUsd={1.25}
        labels={labels}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('role="dialog" aria-modal="true"');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('data-icon="close"');
    expect(html).toContain("Kimi K2");
    expect(html).toContain("high");
    expect(html).toContain("Auto");
    expect(html).toContain("Plan mode");
    expect(html).toContain('class="status-panel__value status-panel__value--on"');
    expect(html).toContain("513 / 1k (51%)");
    expect(html).toContain('style="width:51%"');
    expect(html).toContain("$1.2500");
    expect(html).toContain("status-panel__value--permission-auto");
  });

  it("clamps context usage and omits the bar when no maximum is available", () => {
    expect(statusContextPercent({ ctxUsed: 1, ctxMax: 3 })).toBe(34);
    expect(statusContextPercent({ ctxUsed: 2, ctxMax: 1 })).toBe(100);
    expect(statusContextPercent({ ctxUsed: -1, ctxMax: 100 })).toBe(0);
    expect(statusContextPercent({ ctxUsed: 100, ctxMax: 0 })).toBe(0);

    const html = renderToStaticMarkup(
      <StatusPanel
        status={{ ...status, ctxUsed: 100, ctxMax: 0, permission: "manual" }}
        thinking="off"
        planMode={false}
        labels={labels}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("—");
    expect(html).not.toContain("status-panel__bar");
    expect(html).toContain("Manual");
    expect(html).toContain('<dt>Cost</dt><dd>—</dd>');
  });

  it("only displays positive known costs", () => {
    expect(statusCostText(2, labels.none)).toBe("$2.0000");
    expect(statusCostText(0, labels.none)).toBe(labels.none);
    expect(statusCostText(-1, labels.none)).toBe(labels.none);
    expect(statusCostText(undefined, labels.none)).toBe(labels.none);
  });
});
