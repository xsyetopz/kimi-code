import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./LegacyVueIsland", () => ({
  LegacyVueIsland: () =>
    createElement("div", { "data-kimi-vue-island": "legacy-app" }),
}));
vi.mock("./InternalBuildBanner", () => ({
  InternalBuildBanner: () =>
    createElement("span", { "data-kimi-react-overlay": "internal-build" }),
}));

import { ReactShell } from "./ReactShell";

describe("ReactShell", () => {
  it("renders the Vue island and React-owned root overlays", () => {
    expect(renderToStaticMarkup(<ReactShell />)).toContain(
      '<div data-kimi-vue-island="legacy-app"></div>',
    );
    expect(renderToStaticMarkup(<ReactShell />)).toContain(
      '<span data-kimi-react-overlay="internal-build"></span>',
    );
  });
});
