import type { ReactNode } from "react";

import { iconSvg, type IconName } from "../lib/icons";

export type BannerVariant = "info" | "warning" | "danger";

export interface BannerProps {
  /** Visual status treatment. Defaults to the neutral informational state. */
  variant?: BannerVariant;
  /** Optional replacement for the status icon (the Vue primitive's icon slot). */
  icon?: ReactNode;
  /** Banner message content (the Vue primitive's default slot). */
  children?: ReactNode;
}

function RegisteredIcon({ name }: { name: IconName }): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: iconSvg(name, "md") }}
    />
  );
}

/**
 * Inline status notice. The component is intentionally presentational: its
 * parent owns any actions or state associated with the message.
 */
export function Banner({
  variant = "info",
  icon,
  children,
}: BannerProps): React.ReactElement {
  const defaultIcon: IconName = variant === "info" ? "info" : "alert-triangle";

  return (
    <div className={`ui-banner ui-banner--${variant}`} role="status">
      <span className="ui-banner__icon" aria-hidden="true">
        {icon ?? <RegisteredIcon name={defaultIcon} />}
      </span>
      <span className="ui-banner__text">{children}</span>
    </div>
  );
}

