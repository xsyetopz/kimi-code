import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/icons", () => ({
  iconSvg: (name: string, size: string) =>
    `<svg data-icon="${name}" data-size="${size}"></svg>`,
}));

import type { AppModel } from "../api/types";
import {
  ModelPicker,
  filterModelPickerModels,
  modelPickerTabs,
  type ModelPickerLabels,
} from "./ModelPicker";

const labels: ModelPickerLabels = {
  title: "Switch model",
  close: "Close (Esc)",
  allTab: "All",
  providerTabs: "Model providers",
  searchPlaceholder: "Search models or providers…",
  loading: "Loading models…",
  unavailable: "The daemon does not support model listing yet",
  contextSuffix: (size) => `${size} ctx`,
  emptyNoModels: "The daemon offers no selectable models",
  emptyNoMatch: "No matching models",
  starTitle: "Add to favorites",
  unstarTitle: "Remove from favorites",
  footerHint: "↑↓ Navigate · Enter Select · Esc Close",
};

const models: AppModel[] = [
  {
    id: "moonshot/k2",
    provider: "Moonshot",
    model: "k2",
    displayName: "Kimi K2",
    maxContextSize: 262_144,
    capabilities: ["vision"],
  },
  {
    id: "openai/gpt-5",
    provider: "OpenAI",
    model: "gpt-5",
    maxContextSize: 1_048_576,
  },
];

describe("ModelPicker helpers", () => {
  it("builds a stable all tab followed by first-seen providers", () => {
    expect(modelPickerTabs(models, labels.allTab)).toEqual([
      { id: "all", label: "All" },
      { id: "Moonshot", label: "Moonshot" },
      { id: "OpenAI", label: "OpenAI" },
    ]);
  });

  it("filters by provider and search text while pinning starred models in All", () => {
    expect(
      filterModelPickerModels(models, "", "all", ["openai/gpt-5"]).map(
        (model) => model.id,
      ),
    ).toEqual(["openai/gpt-5", "moonshot/k2"]);
    expect(
      filterModelPickerModels(models, "vision", "all", []).map(
        (model) => model.id,
      ),
    ).toEqual(["moonshot/k2"]);
    expect(
      filterModelPickerModels(models, "", "OpenAI", []).map(
        (model) => model.id,
      ),
    ).toEqual(["openai/gpt-5"]);
  });
});

describe("ModelPicker", () => {
  it("renders the dialog, current model, capabilities, tabs, and context labels", () => {
    const html = renderToStaticMarkup(
      <ModelPicker
        models={models}
        current="moonshot/k2"
        starredIds={["moonshot/k2"]}
        labels={labels}
        onSelect={() => undefined}
        onToggleStar={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('role="dialog" aria-modal="true"');
    expect(html).toContain("Switch model");
    expect(html).toContain('placeholder="Search models or providers…"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Kimi K2");
    expect(html).toContain("vision");
    expect(html).toContain("256k ctx");
    expect(html).toContain('data-icon="check"');
    expect(html).toContain('data-icon="star"');
    expect(html).toContain("Navigate · Enter Select · Esc Close");
  });

  it("keeps loading and unavailable states mutually exclusive with the list", () => {
    const loading = renderToStaticMarkup(
      <ModelPicker
        models={models}
        current=""
        loading
        labels={labels}
        onSelect={() => undefined}
        onToggleStar={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(loading).toContain("Loading models…");
    expect(loading).not.toContain("Kimi K2");

    const unavailable = renderToStaticMarkup(
      <ModelPicker
        models={models}
        current=""
        unavailable
        labels={labels}
        onSelect={() => undefined}
        onToggleStar={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(unavailable).toContain("does not support model listing");
    expect(unavailable).not.toContain("Kimi K2");
  });

  it("distinguishes no models from no search matches", () => {
    const noModels = renderToStaticMarkup(
      <ModelPicker
        models={[]}
        current=""
        labels={labels}
        onSelect={() => undefined}
        onToggleStar={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(noModels).toContain("daemon offers no selectable models");

    const noMatch = renderToStaticMarkup(
      <ModelPicker
        models={models}
        current=""
        labels={labels}
        onSelect={() => undefined}
        onToggleStar={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(noMatch).not.toContain("No matching models");
  });
});
