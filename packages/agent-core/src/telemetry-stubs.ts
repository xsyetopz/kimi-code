// Telemetry stubs — the telemetry package was deleted in the v1→v2 cutover.
export async function withTelemetryContext<T>(_ctx: unknown, fn: () => Promise<T>): Promise<T> { return fn(); }
export const noopTelemetryClient = { track: () => {}, sendEvent: () => {}, flush: () => Promise.resolve(), close: () => Promise.resolve() } as const;
