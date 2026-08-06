import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/icons", () => ({
  iconSvg: (name: string, size: string) =>
    `<svg data-icon="${name}" data-size="${size}"></svg>`,
}));

import type { AppNotice } from "../api/types";
import {
  WarningToasts,
  formatWarningForCopy,
  isError,
  warningKey,
  type WarningToastsLabels,
} from "./WarningToasts";

const labels: WarningToastsLabels = {
  dismiss: "Close",
  errorLabel: "Error",
  diagnostics: "Diagnostics",
  hideDetails: "Hide details",
  showDetails: "Show details",
  copyDetails: "Copy diagnostics",
  copied: "Copied",
};

const notice: AppNotice = {
  severity: "error",
  title: "Model request failed",
  message: "The provider returned an error.",
  details: [{ label: "HTTP status", value: "429" }],
};

describe("WarningToasts", () => {
  it("renders notice diagnostics and warning semantics in the React stack", () => {
    const html = renderToStaticMarkup(
      <WarningToasts
        warnings={[notice]}
        labels={labels}
        onDismiss={() => undefined}
      />,
    );

    expect(html).toContain('class="toasts" role="status" aria-live="polite"');
    expect(html).toContain("Model request failed");
    expect(html).toContain("The provider returned an error.");
    expect(html).toContain("Show details");
    expect(html).toContain("Copy diagnostics");
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain("ui-toast--danger");
    expect(html).toContain('data-icon="close"');
    expect(html).not.toContain("HTTP status");
  });

  it("keeps duplicate instances distinct while classifying text errors", () => {
    const html = renderToStaticMarkup(
      <WarningToasts
        warnings={[
          "same warning",
          "same warning",
          "Error: provider unavailable",
        ]}
        labels={labels}
        onDismiss={() => undefined}
      />,
    );

    expect((html.match(/class="toast-item/g) ?? []).length).toBe(3);
    expect((html.match(/class="ui-toast /g) ?? []).length).toBe(3);
    expect(html).toContain("ui-toast--danger");
    expect(isError("Error: provider unavailable", labels)).toBe(true);
    expect(warningKey("same warning")).toBe(warningKey("same warning"));
  });

  it("formats copied diagnostics with the localized heading", () => {
    expect(formatWarningForCopy(notice, labels.diagnostics)).toBe(
      "Model request failed\nThe provider returned an error.\n\nDiagnostics:\nHTTP status: 429",
    );
  });
});
