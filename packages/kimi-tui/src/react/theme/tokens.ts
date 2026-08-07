/**
 * TypeScript mirror of the shared React kit CSS variables (`--kui-*`).
 * Hosts may read these for programmatic styling; visual truth lives in theme.css.
 */

export const kuiTokens = {
  font: {
    ui: "var(--kui-font-ui)",
    mono: "var(--kui-font-mono)",
  },
  surface: {
    0: "var(--kui-surface-0)",
    1: "var(--kui-surface-1)",
    2: "var(--kui-surface-2)",
  },
  border: {
    default: "var(--kui-border)",
    strong: "var(--kui-border-strong)",
  },
  fg: {
    0: "var(--kui-fg-0)",
    1: "var(--kui-fg-1)",
    2: "var(--kui-fg-2)",
    3: "var(--kui-fg-3)",
  },
  accent: {
    default: "var(--kui-accent)",
    hover: "var(--kui-accent-hover)",
    muted: "var(--kui-accent-muted)",
    on: "var(--kui-on-accent)",
  },
  status: {
    success: "var(--kui-status-success)",
    warning: "var(--kui-status-warning)",
    error: "var(--kui-status-error)",
    info: "var(--kui-status-info)",
  },
  space: {
    1: "var(--kui-space-1)",
    2: "var(--kui-space-2)",
    3: "var(--kui-space-3)",
    4: "var(--kui-space-4)",
    5: "var(--kui-space-5)",
  },
  radius: {
    sm: "var(--kui-radius-sm)",
    md: "var(--kui-radius-md)",
  },
  text: {
    xs: "var(--kui-text-xs)",
    sm: "var(--kui-text-sm)",
    base: "var(--kui-text-base)",
  },
  motion: {
    duration: "var(--kui-duration)",
    ease: "var(--kui-ease)",
  },
} as const;

export type KuiTokenTree = typeof kuiTokens;
