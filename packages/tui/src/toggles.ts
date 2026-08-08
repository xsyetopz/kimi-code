/** WYSIWYG display toggles — change what is shown, not archive truth. */
export interface WysiwygToggles {
  readonly showThinking: boolean;
  readonly showRawAssistant: boolean;
  readonly showUsage: boolean;
  readonly showSwarmVisibility: boolean;
  readonly showModelEffort: boolean;
}

export const DEFAULT_TOGGLES: WysiwygToggles = {
  showThinking: true,
  showRawAssistant: false,
  showUsage: true,
  showSwarmVisibility: true,
  showModelEffort: true,
};

export function toggleKey(
  toggles: WysiwygToggles,
  key: keyof WysiwygToggles,
): WysiwygToggles {
  return { ...toggles, [key]: !toggles[key] };
}
