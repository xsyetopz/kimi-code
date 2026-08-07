import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cx } from "../utils/cx.ts";
import { Spinner } from "./Spinner.tsx";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "sm",
  loading = false,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled ?? loading}
      className={cx(
        "kui-button",
        `kui-button--${variant}`,
        `kui-button--${size}`,
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size="sm" label="Loading" /> : null}
      {children}
    </button>
  );
}
