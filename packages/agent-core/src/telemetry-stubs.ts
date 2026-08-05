// Telemetry stubs — the telemetry package was deleted in the v1→v2 cutover.
// These no-ops keep v1 consumers that still import telemetry symbols compiling.

/** No-op telemetry client that discards every event. */
export const noopTelemetryClient = {
  sendEvent: () => {},
  flush: () => Promise.resolve(),
  close: () => Promise.resolve(),
} as const;

/** Wraps a function with a no-op telemetry context. */
export async function withTelemetryContext<T>(
  _ctx: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  return fn();
}
