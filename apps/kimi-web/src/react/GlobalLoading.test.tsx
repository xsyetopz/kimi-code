import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GlobalLoading, type GlobalLoadingLabels } from "./GlobalLoading";

const labels: GlobalLoadingLabels = {
  connecting: "Connecting…",
  connectRetrying: "Cannot reach the server — retrying…",
};

describe("GlobalLoading", () => {
  it("renders the accessible splash, official wordmark, and plain spinner", () => {
    const html = renderToStaticMarkup(
      <GlobalLoading labels={labels} />,
    );

    expect(html).toContain('class="gload" role="status" aria-label="Connecting…"');
    expect(html).toContain('class="gload-logo"');
    expect(html).toContain('viewBox="0 0 96 32"');
    expect(html).toContain('class="gload-spinner" role="status" aria-label="Connecting…"');
    expect(html).toContain("Connecting…");
    expect(html).not.toContain("gload-issue");
  });

  it("renders the retry explanation and connection issue when provided", () => {
    const html = renderToStaticMarkup(
      <GlobalLoading labels={labels} issue="connection refused" />,
    );

    expect(html).toContain("Cannot reach the server — retrying…");
    expect(html).toContain('class="gload-issue-detail">connection refused</div>');
  });
});

