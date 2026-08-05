/**
 * Engine gate for the CLI surfaces. As of the v1→v2 cutover, agent-core-v2 is
 * the only engine: every CLI surface (`kimi -p`, the interactive TUI,
 * `kimi doctor`, `kimi web`) routes through the v2-backed harness.
 *
 * The `KIMI_CODE_EXPERIMENTAL_FLAG` / `KIMI_CODE_EXPERIMENTAL_ACP_V2` env
 * vars are kept as no-ops for backward compatibility during the transition;
 * the gate is permanently open.
 */

export const KIMI_V2_ENV = "KIMI_CODE_EXPERIMENTAL_FLAG";
export const KIMI_ACP_V2_ENV = "KIMI_CODE_EXPERIMENTAL_ACP_V2";

export function isKimiV2Enabled(
  _env?: Readonly<Record<string, string | undefined>>,
): true {
  return true;
}

export function isAcpV2Enabled(
  _env?: Readonly<Record<string, string | undefined>>,
): true {
  return true;
}
