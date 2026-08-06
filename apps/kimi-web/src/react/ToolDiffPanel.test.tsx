import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/icons", () => ({
  iconSvg: (name: string, size: string) =>
    `<svg data-icon="${name}" data-size="${size}"></svg>`,
}));

import type { ToolDiffTarget } from "../types";
import { ToolDiffPanel } from "./ToolDiffPanel";

const labels = { close: "Close", noDiff: "No diff" };

function target(overrides: Partial<ToolDiffTarget> = {}): ToolDiffTarget {
  return {
    id: "tool-1",
    title: "Edit",
    path: "src/example.ts",
    lines: null,
    ...overrides,
  };
}

describe("ToolDiffPanel", () => {
  it("renders the panel header and localized empty state", () => {
    const html = renderToStaticMarkup(
      <ToolDiffPanel
        target={target()}
        labels={labels}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("Edit");
    expect(html).toContain("src/example.ts");
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain("No diff");
    expect(html).toContain('data-icon="close"');
  });

  it("renders synthesized diff rows with gutters, signs, and text", () => {
    const html = renderToStaticMarkup(
      <ToolDiffPanel
        target={
          target({
            lines: [
              { type: "hunk", text: "@@ -1,2 +1,2 @@" },
              { type: "context", oldNo: 1, newNo: 1, text: "same" },
              { type: "del", oldNo: 2, text: "before" },
              { type: "add", newNo: 2, text: "after" },
            ],
          })
        }
        labels={labels}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("@@ -1,2 +1,2 @@");
    expect(html).toContain("react-tool-diff-line--context");
    expect(html).toContain("react-tool-diff-line--del");
    expect(html).toContain("react-tool-diff-line--add");
    expect(html).toContain(">-</span>");
    expect(html).toContain(">+</span>");
    expect(html).toContain(">before</span>");
    expect(html).toContain(">after</span>");
  });

  it("falls back to raw tool output when no diff is available", () => {
    const html = renderToStaticMarkup(
      <ToolDiffPanel
        target={target({ output: ["first output", "second output"] })}
        labels={labels}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("first output");
    expect(html).toContain("second output");
    expect(html).not.toContain("No diff");
  });

  it("uses output when an empty diff array is supplied", () => {
    const html = renderToStaticMarkup(
      <ToolDiffPanel
        target={target({ lines: [], output: ["operation failed"] })}
        labels={labels}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("operation failed");
    expect(html).not.toContain("No diff");
  });
});

