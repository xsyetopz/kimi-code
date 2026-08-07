/**
 * `auth` domain — shared helpers for RFC 8628 device-OAuth provider adapters.
 *
 * Flow snapshot mapping and abortable polling sleep are identical across the
 * OpenCode, Copilot, and Codex adapters; provider-specific token exchange
 * stays in each adapter.
 */

import type { OAuthFlowSnapshot, OAuthFlowStart } from "./oauthProtocol";

export interface DeviceOAuthFlow {
  readonly flowId: string;
  readonly provider: string;
  readonly controller: AbortController;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly userCode: string;
  readonly expiresAt: number;
  interval: number;
  status: OAuthFlowSnapshot["status"];
  resolvedAt?: string;
  errorMessage?: string;
}

export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function completeDeviceOAuthFlow(
  flow: DeviceOAuthFlow,
  status: Extract<OAuthFlowSnapshot["status"], "authenticated" | "expired">,
  now: () => number,
): void {
  if (flow.status !== "pending") return;
  flow.status = status;
  flow.resolvedAt = new Date(now()).toISOString();
}

export function failDeviceOAuthFlow(
  flow: DeviceOAuthFlow,
  message: string,
  now: () => number,
): void {
  if (flow.status !== "pending") return;
  flow.status = "denied";
  flow.errorMessage = message;
  flow.resolvedAt = new Date(now()).toISOString();
}

export function toDeviceOAuthFlowStart(
  flow: DeviceOAuthFlow,
  now: () => number,
): OAuthFlowStart {
  return {
    flow_id: flow.flowId,
    provider: flow.provider,
    status: "pending",
    verification_uri: flow.verificationUri,
    verification_uri_complete: flow.verificationUriComplete,
    user_code: flow.userCode,
    expires_in: Math.max(1, Math.ceil((flow.expiresAt - now()) / 1000)),
    interval: flow.interval,
    expires_at: new Date(flow.expiresAt).toISOString(),
  };
}

export function toDeviceOAuthFlowSnapshot(
  flow: DeviceOAuthFlow,
  now: () => number,
): OAuthFlowSnapshot {
  return {
    flow_id: flow.flowId,
    provider: flow.provider,
    status: flow.status,
    verification_uri: flow.verificationUri,
    verification_uri_complete: flow.verificationUriComplete,
    user_code: flow.userCode,
    expires_in: Math.max(1, Math.ceil((flow.expiresAt - now()) / 1000)),
    interval: flow.interval,
    expires_at: new Date(flow.expiresAt).toISOString(),
    ...(flow.resolvedAt === undefined ? {} : { resolved_at: flow.resolvedAt }),
    ...(flow.errorMessage === undefined
      ? {}
      : { error_message: flow.errorMessage }),
  };
}
