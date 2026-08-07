import type { HTMLAttributes } from "react";

import { cx } from "../utils/cx.ts";

export type SpinnerSize = "sm" | "md";

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: SpinnerSize;
  /** Accessible label for screen readers. */
  label?: string;
}

export function Spinner({
  size = "md",
  label = "Loading",
  className,
  ...rest
}: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cx("kui-spinner", `kui-spinner--${size}`, className)}
      {...rest}
    />
  );
}
