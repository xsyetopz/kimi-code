import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/icons", () => ({
  iconSvg: (name: string, size: string) =>
    `<svg data-icon="${name}" data-size="${size}"></svg>`,
}));

import {
  ThinkingPanel,
  isNearBottom,
  type ThinkingPanelLabels,
} from "./ThinkingPanel";

const labels: ThinkingPanelLabels = {
  preview: "Preview",
  panelTitle: "Thinking",
  close: "Close",
};

describe("ThinkingPanel", () => {
  it("renders the shared preview header, localized labels, and streaming text", () => {
    const html = renderToStaticMarkup(
      <ThinkingPanel labels={labels} text={"first line\nsecond line"} onClose={() => undefined} />,
    );

    expect(html).toContain('class="thinking-panel"');
    expect(html).toContain('class="thinking-panel__header"');
    expect(html).toContain('class="thinking-panel__title">Preview</span>');
    expect(html).toContain('class="thinking-panel__subtitle" title="Thinking">Thinking</span>');
    expect(html).toContain('class="thinking-panel__body">first line\nsecond line</pre>');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('data-icon="close"');
  });

  it("uses the supplied subtitle without changing the preview title", () => {
    const html = renderToStaticMarkup(
      <ThinkingPanel
        labels={labels}
        text="summary"
        subtitle="Conversation summary"
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('class="thinking-panel__title">Preview</span>');
    expect(html).toContain(
      'class="thinking-panel__subtitle" title="Conversation summary">Conversation summary</span>',
    );
    expect(html).not.toContain(">Thinking</span>");
  });

  it("treats a body within the follow threshold as being at the bottom", () => {
    expect(isNearBottom({ scrollHeight: 600, scrollTop: 477, clientHeight: 100 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 600, scrollTop: 476, clientHeight: 100 })).toBe(false);
  });
});
