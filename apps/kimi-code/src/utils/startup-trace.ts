// Startup phase tracer, enabled with KIMI_STARTUP_TRACE=1.
// Writes through the SDK diagnostic log so traces land in kimi-code.log.

import { log } from "@moonshot-ai/kimi-code-sdk";

const enabled =
  process.env["KIMI_STARTUP_TRACE"] !== undefined &&
  process.env["KIMI_STARTUP_TRACE"] !== "";
const t0 = performance.now();

export function startupTrace(label: string): void {
  if (!enabled) return;
  log.debug("startup trace", {
    label,
    elapsedMs: Math.round(performance.now() - t0),
  });
}
