import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/desktopFlag", () => ({ isDesktop: true }));

import { InternalBuildBanner } from "./InternalBuildBanner";

describe("InternalBuildBanner", () => {
  it("renders the desktop-only marker with accessible text", () => {
    const html = renderToStaticMarkup(<InternalBuildBanner />);
    expect(html).toContain('role="note"');
    expect(html).toContain("Internal testing only");
  });
});
