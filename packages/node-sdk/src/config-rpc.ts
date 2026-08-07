import {
  ErrorCodes,
  KimiError,
  resolveConfigPath,
} from "#/compat";
import { parseConfigString } from "#/config-validate";
import { z } from "zod";

export type KimiConfigValidationPathSegment = string | number;

export interface KimiConfigValidationIssue {
  readonly path: readonly KimiConfigValidationPathSegment[];
  readonly message: string;
}

export interface ResolveKimiConfigPathInput {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
}

export interface ValidateKimiConfigTomlInput {
  readonly text: string;
  readonly filePath?: string | undefined;
}

export interface KimiConfigRpc {
  resolveConfigPath(input?: ResolveKimiConfigPathInput): Promise<string>;
  validateConfigToml(input: ValidateKimiConfigTomlInput): Promise<void>;
}

class KimiConfigCoreRpcImpl {
  resolveConfigPath(input: ResolveKimiConfigPathInput): string {
    return resolveConfigPath(input);
  }

  validateConfigToml(input: ValidateKimiConfigTomlInput): void {
    try {
      parseConfigString(input.text, input.filePath);
    } catch (error) {
      const validationIssues = extractValidationIssues(error);
      if (validationIssues !== undefined) {
        throw toConfigValidationError(error, validationIssues);
      }
      throw error;
    }
  }
}

export class KimiConfigRpcClient implements KimiConfigRpc {
  private readonly core = new KimiConfigCoreRpcImpl();

  resolveConfigPath(
    input: ResolveKimiConfigPathInput = {},
  ): Promise<string> {
    return Promise.resolve(this.core.resolveConfigPath(input));
  }

  validateConfigToml(input: ValidateKimiConfigTomlInput): Promise<void> {
    return Promise.resolve(this.core.validateConfigToml(input));
  }
}

export function createKimiConfigRpc(): KimiConfigRpc {
  return new KimiConfigRpcClient();
}

function toConfigValidationError(
  error: unknown,
  validationIssues: readonly KimiConfigValidationIssue[],
): KimiError {
  const details =
    error instanceof KimiError && error.details !== undefined
      ? { ...error.details, validationIssues }
      : { validationIssues };

  if (error instanceof KimiError) {
    return new KimiError(error.code, error.message, { details });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new KimiError(ErrorCodes.CONFIG_INVALID, message, { details });
}

function extractValidationIssues(
  error: unknown,
): readonly KimiConfigValidationIssue[] | undefined {
  const zodError = findZodError(error);
  if (zodError === undefined) return undefined;
  return zodError.issues.map((issue) => ({
    path: issue.path.map((segment) =>
      typeof segment === "number" ? segment : String(segment),
    ),
    message: issue.message,
  }));
}

function findZodError(error: unknown): z.ZodError | undefined {
  if (error instanceof z.ZodError) return error;
  if (error instanceof Error && error.cause instanceof z.ZodError)
    return error.cause;
  return undefined;
}
