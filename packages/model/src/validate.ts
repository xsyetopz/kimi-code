import type { ReasoningMode } from "@kimi-next/ir";
import { supportsReasoningMode } from "./capabilities";
import type { ModelProfile } from "./profile";

export type ModelValidationErrorCode =
  | "UNSUPPORTED_VISION"
  | "UNSUPPORTED_TOOLS"
  | "UNSUPPORTED_REASONING"
  | "UNSUPPORTED_PARAMETER";

export class ModelValidationError extends Error {
  readonly code: ModelValidationErrorCode;

  constructor(code: ModelValidationErrorCode, message: string) {
    super(message);
    this.name = "ModelValidationError";
    this.code = code;
  }
}

export interface RequestParameters {
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number;
  readonly stopSequences?: readonly string[];
  /** Stable key for provider prompt caching (e.g. OpenAI prompt_cache_key). */
  readonly cacheKey?: string;
}

export interface ValidateRequestInput {
  readonly profile: ModelProfile;
  readonly tools?: boolean;
  readonly vision?: boolean;
  readonly reasoning?: ReasoningMode;
  readonly params?: RequestParameters;
}

export function validateRequest(input: ValidateRequestInput): void {
  const { profile, tools, vision, reasoning, params } = input;

  if (vision && !profile.capabilities.input.images) {
    throw new ModelValidationError(
      "UNSUPPORTED_VISION",
      `Model ${profile.id} does not support vision input`,
    );
  }

  if (tools && !profile.capabilities.output.toolCalls) {
    throw new ModelValidationError(
      "UNSUPPORTED_TOOLS",
      `Model ${profile.id} does not support tool calls`,
    );
  }

  if (
    reasoning !== undefined &&
    !supportsReasoningMode(profile.capabilities, reasoning)
  ) {
    throw new ModelValidationError(
      "UNSUPPORTED_REASONING",
      `Model ${profile.id} does not support reasoning mode "${reasoning}"`,
    );
  }

  if (params) {
    validateParameters(profile, params);
  }
}

function validateParameters(
  profile: ModelProfile,
  params: RequestParameters,
): void {
  if (params.temperature !== undefined && !profile.parameters.temperature) {
    throw unsupportedParam(profile, "temperature");
  }
  if (params.topP !== undefined && !profile.parameters.topP) {
    throw unsupportedParam(profile, "topP");
  }
  if (
    params.maxOutputTokens !== undefined &&
    !profile.parameters.maxOutputTokens
  ) {
    throw unsupportedParam(profile, "maxOutputTokens");
  }
  if (
    params.stopSequences !== undefined &&
    !profile.parameters.stopSequences
  ) {
    throw unsupportedParam(profile, "stopSequences");
  }
}

function unsupportedParam(
  profile: ModelProfile,
  name: string,
): ModelValidationError {
  return new ModelValidationError(
    "UNSUPPORTED_PARAMETER",
    `Model ${profile.id} does not support parameter "${name}"`,
  );
}
