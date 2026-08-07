import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "../utils/cx.ts";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "error" | "info";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  children?: ReactNode;
}

export function Badge({
  tone = "neutral",
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cx("kui-badge", `kui-badge--${tone}`, className)}
      {...rest}
    >
      {children}
    </span>
  );
}
