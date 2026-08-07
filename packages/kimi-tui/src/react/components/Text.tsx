import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "../utils/cx.ts";

export type TextVariant = "body" | "label" | "caption" | "mono" | "muted" | "faint";

export interface TextProps extends HTMLAttributes<HTMLElement> {
  as?: "p" | "span" | "div";
  variant?: TextVariant;
  children?: ReactNode;
}

export function Text({
  as: Tag = "span",
  variant = "body",
  className,
  children,
  ...rest
}: TextProps) {
  return (
    <Tag
      className={cx("kui-text", `kui-text--${variant}`, className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}
