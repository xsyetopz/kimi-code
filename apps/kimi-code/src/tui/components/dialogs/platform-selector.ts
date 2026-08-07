import { OPEN_PLATFORMS } from "@moonshot-ai/kimi-code-oauth";

import { ChoicePickerComponent, type ChoiceOption } from "./choice-picker";

export const EXTERNAL_OAUTH_PLATFORM_OPTIONS: readonly ChoiceOption[] = [
  { value: "opencode", label: "OpenCode Zen (OAuth)" },
  { value: "opencode-go", label: "OpenCode Go (OAuth)" },
];

export const EXTERNAL_OAUTH_PROVIDER_IDS = new Set(
  EXTERNAL_OAUTH_PLATFORM_OPTIONS.map((option) => option.value),
);

export const EXTERNAL_OAUTH_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
};

const PLATFORM_OPTIONS: readonly ChoiceOption[] = [
  { value: "kimi-code", label: "Kimi Code (OAuth)" },
  ...EXTERNAL_OAUTH_PLATFORM_OPTIONS,
  ...OPEN_PLATFORMS.map((platform) => ({
    value: platform.id,
    label: platform.name,
  })),
];

export interface PlatformSelectorOptions {
  readonly onSelect: (platformId: string) => void;
  readonly onCancel: () => void;
}

export class PlatformSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PlatformSelectorOptions) {
    super({
      title: "Select a platform",
      options: [...PLATFORM_OPTIONS],
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
