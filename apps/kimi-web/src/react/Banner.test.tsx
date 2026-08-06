import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/icons", () => ({
  iconSvg: (name: string, size: string) =>
    `<svg data-icon="${name}" data-size="${size}"></svg>`,
}));

import { Banner } from "./Banner";

describe("Banner", () => {
  it("renders the default informational notice and registered icon", () => {
    const html = renderToStaticMarkup(<Banner>Connected to server</Banner>);

    expect(html).toContain('class="ui-banner ui-banner--info" role="status"');
    expect(html).toContain('data-icon="info"');
    expect(html).toContain("Connected to server");
  });

  it.each([
    ["warning", "alert-triangle"],
    ["danger", "alert-triangle"],
  ] as const)("uses the %s treatment and alert icon", (variant, icon) => {
    const html = renderToStaticMarkup(
      <Banner variant={variant}>Needs attention</Banner>,
    );

    expect(html).toContain(`ui-banner--${variant}`);
    expect(html).toContain(`data-icon="${icon}"`);
  });

  it("preserves custom icon content from the icon slot", () => {
    const html = renderToStaticMarkup(
      <Banner icon={<span data-testid="custom-icon">!</span>}>Custom</Banner>,
    );

    expect(html).toContain('data-testid="custom-icon"');
    expect(html).not.toContain("data-icon=\"info\"");
  });
});

