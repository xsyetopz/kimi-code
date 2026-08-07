/**
 * `auth` domain — registers experimental auth integration flags into `flag`.
 *
 * Gates provider-owned OAuth adapters that are not yet generally available.
 * Off by default; enable via per-feature `KIMI_CODE_EXPERIMENTAL_*` env vars,
 * the master `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config
 * section.
 */

import {
  type FlagDefinitionInput,
  registerFlagDefinition,
} from "#/app/flag/flagRegistry";

export const COPILOT_OAUTH_FLAG_ID = "copilot-oauth";
export const COPILOT_OAUTH_FLAG_ENV = "KIMI_CODE_EXPERIMENTAL_COPILOT_OAUTH";

export const CODEX_OAUTH_FLAG_ID = "codex-oauth";
export const CODEX_OAUTH_FLAG_ENV = "KIMI_CODE_EXPERIMENTAL_CODEX_OAUTH";

export const copilotOAuthFlag: FlagDefinitionInput = {
  id: COPILOT_OAUTH_FLAG_ID,
  title: "GitHub Copilot OAuth",
  description:
    "Register the GitHub Copilot device-OAuth adapter for interactive login. API-key env fallbacks remain available when this flag is off.",
  env: COPILOT_OAUTH_FLAG_ENV,
  default: false,
  surface: "both",
};

export const codexOAuthFlag: FlagDefinitionInput = {
  id: CODEX_OAUTH_FLAG_ID,
  title: "OpenAI Codex OAuth",
  description:
    "Register the OpenAI Codex official device-OAuth adapter for ChatGPT subscription login. API-key env fallbacks remain available when this flag is off.",
  env: CODEX_OAUTH_FLAG_ENV,
  default: false,
  surface: "both",
};

registerFlagDefinition(copilotOAuthFlag);
registerFlagDefinition(codexOAuthFlag);
