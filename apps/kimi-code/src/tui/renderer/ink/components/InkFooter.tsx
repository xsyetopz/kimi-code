import { Text } from "ink";
import { type ReactNode } from "react";

import type { InkChromeProjection } from "../terminal-view";

export interface InkFooterProps {
  readonly chrome: InkChromeProjection;
}

/** Renders the bottom status line from the renderer-neutral chrome projection. */
export function InkFooter({ chrome }: InkFooterProps): ReactNode {
  return <Text dimColor>{chrome.footer}</Text>;
}
