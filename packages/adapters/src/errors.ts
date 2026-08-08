export type ErrorClass = "CONFIGURATION" | "REQUEST" | "TRANSIENT";

export interface ClassifiedError {
  readonly class: ErrorClass;
  readonly message: string;
  readonly retryable: boolean;
  readonly statusCode?: number;
}

export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof AdapterHttpError) {
    return classifyHttpStatus(error.statusCode, error.message);
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    lower.includes("api key") ||
    lower.includes("authentication") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return { class: "CONFIGURATION", message, retryable: false };
  }

  if (
    lower.includes("rate limit") ||
    lower.includes("timeout") ||
    lower.includes("overloaded") ||
    lower.includes("503") ||
    lower.includes("502") ||
    lower.includes("429")
  ) {
    return { class: "TRANSIENT", message, retryable: true };
  }

  if (
    lower.includes("invalid") ||
    lower.includes("bad request") ||
    lower.includes("unsupported") ||
    lower.includes("400")
  ) {
    return { class: "REQUEST", message, retryable: false };
  }

  return { class: "REQUEST", message, retryable: false };
}

export class AdapterHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AdapterHttpError";
  }
}

function classifyHttpStatus(
  statusCode: number,
  message: string,
): ClassifiedError {
  if (statusCode === 401 || statusCode === 403) {
    return {
      class: "CONFIGURATION",
      message,
      retryable: false,
      statusCode,
    };
  }
  if (statusCode === 429 || statusCode >= 500) {
    return {
      class: "TRANSIENT",
      message,
      retryable: true,
      statusCode,
    };
  }
  return {
    class: "REQUEST",
    message,
    retryable: false,
    statusCode,
  };
}
