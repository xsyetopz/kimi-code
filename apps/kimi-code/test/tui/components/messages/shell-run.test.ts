import { afterEach, describe, expect, it } from "vitest";

import { ShellRunComponent } from "#/tui/components/messages/shell-run";
import { projectShellRunLines } from "#/tui/projections/shell-run";
import { darkColors } from "#/tui/theme/colors";
import { currentTheme } from "#/tui/theme";

function stripTheme(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, "");
}

describe("projectShellRunLines", () => {
  it("matches the live component for a finished command", () => {
    currentTheme.setPalette(darkColors);
    const component = new ShellRunComponent(() => {});
    component.finish("final output", "stderr line", false);
    const projected = projectShellRunLines(component.captureShellRunState());
    const live = stripTheme(component.render(100).join("\n"));
    for (const line of projected) {
      expect(live).toContain(stripTheme(line).trimEnd());
    }
    component.dispose();
  });

  it("matches the live component for a backgrounded command", () => {
    currentTheme.setPalette(darkColors);
    const component = new ShellRunComponent(() => {});
    component.finishBackgrounded();
    const projected = projectShellRunLines(component.captureShellRunState());
    const live = stripTheme(component.render(100).join("\n"));
    for (const line of projected) {
      expect(live).toContain(stripTheme(line).trimEnd());
    }
    component.dispose();
  });
});

describe("ShellRunComponent hardening", () => {
  let component: ShellRunComponent | undefined;

  afterEach(() => {
    // Always clear the 1s timer so it can't keep the test process alive or
    // fire requestRender after the test ends.
    component?.dispose();
    component = undefined;
  });

  function create(): ShellRunComponent {
    component = new ShellRunComponent(() => {});
    return component;
  }

  it("caps the running buffer and never throws on huge streaming output", () => {
    const c = create();
    const chunk = "x".repeat(50_000);
    expect(() => {
      for (let i = 0; i < 20; i++) c.append(chunk);
      c.render(100);
    }).not.toThrow();
  });

  it("finish switches to the final view and ignores later appends", () => {
    const c = create();
    c.finish("final output", "", false);
    c.append("should be ignored");
    const rendered = stripTheme(c.render(100).join("\n"));
    expect(rendered).toContain("final output");
    expect(rendered).not.toContain("should be ignored");
  });

  it("finishBackgrounded renders the background hint", () => {
    const c = create();
    c.finishBackgrounded();
    const rendered = stripTheme(c.render(100).join("\n"));
    expect(rendered).toContain("Moved to background.");
  });

  it("append / finish are no-ops after dispose", () => {
    const c = create();
    c.dispose();
    expect(() => {
      c.append("late");
      c.finish("late", "", false);
      c.finishBackgrounded();
      c.render(100);
    }).not.toThrow();
  });

  it("does not throw when the render callback throws", () => {
    const c = new ShellRunComponent(() => {
      throw new Error("render failed");
    });
    component = c;
    expect(() => {
      c.append("output");
      c.render(100);
    }).not.toThrow();
  });
});
