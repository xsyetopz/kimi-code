import { OPEN_PLATFORMS } from "@moonshot-ai/kimi-code-oauth";

import { ChoicePickerComponent, type ChoiceOption } from "./choice-picker";

export const GITHUB_COPILOT_PROVIDER_ID = "github-copilot";

export const EXTERNAL_OAUTH_PLATFORM_OPTIONS: readonly ChoiceOption[] = [
  { value: "opencode", label: "OpenCode Zen (OAuth)" },
  { value: "opencode-go", label: "OpenCode Go (OAuth)" },
];

export const GITHUB_COPILOT_PLATFORM_OPTION: ChoiceOption = {
  value: GITHUB_COPILOT_PROVIDER_ID,
  label: "GitHub Copilot (OAuth)",
};

export const EXTERNAL_OAUTH_PROVIDER_IDS = new Set([
  ...EXTERNAL_OAUTH_PLATFORM_OPTIONS.map((option) => option.value),
  GITHUB_COPILOT_PROVIDER_ID,
]);

export const EXTERNAL_OAUTH_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  [GITHUB_COPILOT_PROVIDER_ID]: "GitHub Copilot",
};

export function buildPlatformOptions(showCopilotOAuth: boolean): ChoiceOption[] {
  return [
    { value: "kimi-code", label: "Kimi Code (OAuth)" },
    ...EXTERNAL_OAUTH_PLATFORM_OPTIONS,
    ...(showCopilotOAuth ? [GITHUB_COPILOT_PLATFORM_OPTION] : []),
    ...OPEN_PLATFORMS.map((platform) => ({
      value: platform.id,
      label: platform.name,
    })),
  ];
}

export interface PlatformSelectorOptions {
  readonly showCopilotOAuth?: boolean;
  readonly onSelect: (platformId: string) => void;
  readonly onCancel: () => void;
}

export class PlatformSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PlatformSelectorOptions) {
    super({
      title: "Select a platform",
      options: buildPlatformOptions(opts.showCopilotOAuth ?? false),
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
