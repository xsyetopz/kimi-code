import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
  getEmbeddedNativeAssetManifest,
  getNativePackageRoot,
} from "./native-assets";

const smokePackages = ["@mariozechner/clipboard", "@moonshot-ai/kimi-tui"];

function smokePiTuiNativeLoad(): void {
  const platform = process.platform;
  const arch = process.arch;
  let rel: string | undefined;
  if (platform === "darwin" && (arch === "x64" || arch === "arm64")) {
    rel = join(
      "native",
      "darwin",
      "prebuilds",
      `darwin-${arch}`,
      "darwin-modifiers.node",
    );
  } else if (platform === "win32" && (arch === "x64" || arch === "arm64")) {
    rel = join(
      "native",
      "win32",
      "prebuilds",
      `win32-${arch}`,
      "win32-console-mode.node",
    );
  }
  if (rel === undefined) return;

  const req = createRequire(import.meta.url);
  const helper = req(join(dirname(process.execPath), rel)) as {
    isModifierPressed?: unknown;
    enableVirtualTerminalInput?: unknown;
  };
  if (
    typeof helper.isModifierPressed !== "function" &&
    typeof helper.enableVirtualTerminalInput !== "function"
  ) {
    throw new TypeError(
      `kimi-tui native helper exports are unexpected: ${rel}`,
    );
  }
}

async function runSmoke(): Promise<void> {
  const manifest = getEmbeddedNativeAssetManifest();
  if (manifest === null)
    throw new Error("Native asset manifest is not available.");
  for (const packageName of smokePackages) {
    if (getNativePackageRoot(packageName, { manifest }) === null) {
      throw new Error(`Native package is not available: ${packageName}`);
    }
  }
  smokePiTuiNativeLoad();
  process.stdout.write(`Native asset smoke passed: ${manifest.target}\n`);
}

export function runNativeAssetSmokeIfRequested(): boolean {
  if (process.env["KIMI_CODE_NATIVE_ASSET_SMOKE"] !== "1") return false;
  void runSmoke().then(
    () => process.exit(0),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Native asset smoke failed: ${message}\n`);
      process.exit(1);
    },
  );
  return true;
}
