import type {
  ApprovalRequest,
  ApprovalResponse,
  Event,
  QuestionRequest,
  QuestionResult,
} from "#/compat";

export interface ToolCallRequest {
  readonly toolCallId: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ToolCallResponse {
  readonly output: string;
  readonly isError: boolean;
}

/** Reverse-RPC surface the host implements for in-process session wiring. */
export interface SDKAPI {
  emitEvent(event: Event): void;
  requestApproval(
    request: ApprovalRequest & { sessionId: string; agentId: string },
  ): Promise<ApprovalResponse>;
  requestQuestion(
    request: QuestionRequest & { sessionId: string; agentId: string },
  ): Promise<QuestionResult>;
  toolCall(request: ToolCallRequest): Promise<ToolCallResponse>;
}

/**
 * Legacy v1 core RPC method map. The v2 harness boots agent-core in-process and
 * does not expose a live core proxy — kept for type compatibility with
 * {@link SDKRpcClientBase.getRpc}.
 */
export interface CoreAPI {
  readonly [method: string]: (...args: readonly unknown[]) => unknown;
}

export type RPCMethods<T extends object> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K];
};
