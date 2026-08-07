import { OPEN_PLATFORMS } from "@moonshot-ai/kimi-code-oauth";

import { ChoicePickerComponent, type ChoiceOption } from "./choice-picker";

export const GITHUB_COPILOT_PROVIDER_ID = "github-copilot";
export const OPENAI_CODEX_PROVIDER_ID = "openai";

export const EXTERNAL_OAUTH_PLATFORM_OPTIONS: readonly ChoiceOption[] = [
  { value: "opencode", label: "OpenCode Zen (OAuth)" },
  { value: "opencode-go", label: "OpenCode Go (OAuth)" },
];

export const GITHUB_COPILOT_PLATFORM_OPTION: ChoiceOption = {
  value: GITHUB_COPILOT_PROVIDER_ID,
  label: "GitHub Copilot (OAuth)",
};

export const OPENAI_CODEX_PLATFORM_OPTION: ChoiceOption = {
  value: OPENAI_CODEX_PROVIDER_ID,
  label: "OpenAI Codex (OAuth)",
};

export const EXTERNAL_OAUTH_PROVIDER_IDS = new Set([
  ...EXTERNAL_OAUTH_PLATFORM_OPTIONS.map((option) => option.value),
  GITHUB_COPILOT_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_ID,
]);

export const EXTERNAL_OAUTH_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  [GITHUB_COPILOT_PROVIDER_ID]: "GitHub Copilot",
  [OPENAI_CODEX_PROVIDER_ID]: "OpenAI Codex",
};

export function buildPlatformOptions(options: {
  readonly showCopilotOAuth?: boolean;
  readonly showCodexOAuth?: boolean;
}): ChoiceOption[] {
  return [
    { value: "kimi-code", label: "Kimi Code (OAuth)" },
    ...EXTERNAL_OAUTH_PLATFORM_OPTIONS,
    ...(options.showCopilotOAuth ? [GITHUB_COPILOT_PLATFORM_OPTION] : []),
    ...(options.showCodexOAuth ? [OPENAI_CODEX_PLATFORM_OPTION] : []),
    ...OPEN_PLATFORMS.map((platform) => ({
      value: platform.id,
      label: platform.name,
    })),
  ];
}

export interface PlatformSelectorOptions {
  readonly showCopilotOAuth?: boolean;
  readonly showCodexOAuth?: boolean;
  readonly onSelect: (platformId: string) => void;
  readonly onCancel: () => void;
}

export class PlatformSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PlatformSelectorOptions) {
    super({
      title: "Select a platform",
      options: buildPlatformOptions({
        showCopilotOAuth: opts.showCopilotOAuth ?? false,
        showCodexOAuth: opts.showCodexOAuth ?? false,
      }),
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
