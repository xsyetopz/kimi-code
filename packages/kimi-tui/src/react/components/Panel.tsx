import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "../utils/cx.ts";

export type PanelPadding = "none" | "sm" | "md";

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  padding?: PanelPadding;
  children?: ReactNode;
}

export function Panel({
  padding = "md",
  className,
  children,
  ...rest
}: PanelProps) {
  return (
    <div
      className={cx(
        "kui-panel",
        padding === "sm" && "kui-panel--pad-sm",
        padding === "md" && "kui-panel--pad-md",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
