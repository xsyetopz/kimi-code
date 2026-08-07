import type { ReactNode } from "react";

import { cx } from "../utils/cx.ts";

export interface EmptyStateProps {
  title?: string;
  hint?: string;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  hint,
  icon,
  children,
  className,
}: EmptyStateProps) {
  return (
    <div className={cx("kui-empty", className)}>
      {icon ? <div className="kui-empty__icon">{icon}</div> : null}
      {title ? <p className="kui-empty__title">{title}</p> : null}
      {hint ? <p className="kui-empty__hint">{hint}</p> : null}
      {children}
    </div>
  );
}
