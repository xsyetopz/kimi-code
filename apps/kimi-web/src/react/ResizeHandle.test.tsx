import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { clampResizeWidth, ResizeHandle } from "./ResizeHandle";

describe("ResizeHandle", () => {
  it("renders the separator semantics and design-system handle surface", () => {
    const html = renderToStaticMarkup(
      <ResizeHandle
        storageKey="kimi-web.sidebar-width"
        defaultWidth={270}
        min={170}
        max={480}
        ariaLabel="Resize sidebar width"
        onWidthChange={vi.fn()}
        onDraggingChange={vi.fn()}
      />,
    );

    expect(html).toContain('class="rh"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-label="Resize sidebar width"');
    expect(html).toContain('class="rh-bar" aria-hidden="true"');
  });

  it("marks the handle while dragging and preserves reverse-capable props", () => {
    const html = renderToStaticMarkup(
      <ResizeHandle
        storageKey="kimi-web.preview-width"
        defaultWidth={460}
        min={320}
        max={720}
        reverse
        dragging
        ariaLabel="Resize preview width"
        onWidthChange={vi.fn()}
        onDraggingChange={vi.fn()}
      />,
    );

    expect(html).toContain('class="rh dragging"');
    expect(html).toContain('aria-label="Resize preview width"');
  });

  it.each([
    [Number.NaN, 270],
    [Number.POSITIVE_INFINITY, 270],
    [170.4, 170],
    [270.6, 271],
    [20, 170],
    [900, 480],
  ])("clamps %s to %s", (value, expected) => {
    expect(
      clampResizeWidth(value, { defaultWidth: 270, min: 170, max: 480 }),
    ).toBe(expected);
  });
});
