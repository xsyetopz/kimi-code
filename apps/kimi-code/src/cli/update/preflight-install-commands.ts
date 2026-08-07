import { spawn } from "node:child_process";

import {
  KIMI_CODE_OFFICIAL_INSTALL_URL,
  NATIVE_INSTALL_COMMAND_UNIX,
  NATIVE_INSTALL_COMMAND_WIN,
} from "#/constant/app";

import {
  NPM_PACKAGE_NAME,
  type InstallSource,
  type UpdateTarget,
} from "./types";

function withCmdSuffix(base: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${base}.cmd` : base;
}

function bunCommand(platform: NodeJS.Platform): string {
  return platform === "win32" ? "bun.exe" : "bun";
}

export function installCommandFor(
  source: InstallSource,
  version: string,
  platform: NodeJS.Platform,
): string {
  switch (source) {
    case "npm-global":
      return `npm install -g ${NPM_PACKAGE_NAME}@${version}`;
    case "pnpm-global":
      return `pnpm add -g ${NPM_PACKAGE_NAME}@${version}`;
    case "yarn-global":
      return `yarn global add ${NPM_PACKAGE_NAME}@${version}`;
    case "bun-global":
      return `bun add -g ${NPM_PACKAGE_NAME}@${version}`;
    case "homebrew":
      return "brew upgrade kimi-code";
    case "native":
      return platform === "win32"
        ? NATIVE_INSTALL_COMMAND_WIN
        : NATIVE_INSTALL_COMMAND_UNIX;
    case "unsupported":
      return `npm install -g ${NPM_PACKAGE_NAME}@${version}`;
  }
}

export function canAutoInstall(
  source: InstallSource,
  platform: NodeJS.Platform,
): boolean {
  switch (source) {
    case "npm-global":
    case "pnpm-global":
    case "yarn-global":
    case "bun-global":
      return true;
    case "homebrew":
      // Homebrew upgrade may mutate other dependents and the formula can lag
      // behind the CDN release — prompt the user to run `brew upgrade` manually.
      return false;
    case "native":
      return platform !== "win32";
    case "unsupported":
      return false;
  }
}

interface SpawnCommand {
  readonly cmd: string;
  readonly args: readonly string[];
}

export function spawnForSource(
  source: InstallSource,
  version: string,
  platform: NodeJS.Platform,
): SpawnCommand {
  switch (source) {
    case "npm-global":
      return {
        cmd: withCmdSuffix("npm", platform),
        args: ["install", "-g", `${NPM_PACKAGE_NAME}@${version}`],
      };
    case "pnpm-global":
      return {
        cmd: withCmdSuffix("pnpm", platform),
        args: ["add", "-g", `${NPM_PACKAGE_NAME}@${version}`],
      };
    case "yarn-global":
      return {
        cmd: withCmdSuffix("yarn", platform),
        args: ["global", "add", `${NPM_PACKAGE_NAME}@${version}`],
      };
    case "bun-global":
      return {
        cmd: bunCommand(platform),
        args: ["add", "-g", `${NPM_PACKAGE_NAME}@${version}`],
      };
    case "homebrew":
      return { cmd: "brew", args: ["upgrade", "kimi-code"] };
    case "native":
      // `curl … | bash` reports only the trailing bash's exit status, so a
      // failed download (curl can't connect → empty stdin → bash exits 0)
      // would look like a successful update. `pipefail` makes the pipeline
      // surface curl's non-zero status so installUpdate() rejects and we warn
      // instead of printing "Updated …".
      return {
        cmd: "bash",
        args: ["-c", `set -o pipefail; ${NATIVE_INSTALL_COMMAND_UNIX}`],
      };
    case "unsupported":
      throw new Error("unsupported install source cannot be auto-installed");
  }
}

export function formatUpdateErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const THIRD_PARTY_SOURCE_NOTE =
  "\nNote: Third-party sources may lag behind the official release.\n" +
  `For the latest updates, use the official installer: ${KIMI_CODE_OFFICIAL_INSTALL_URL}\n`;

export function renderManualUpdateMessage(
  currentVersion: string,
  target: UpdateTarget,
  source: InstallSource,
  installCommand: string,
): string {
  let sourceDesc: string;
  switch (source) {
    case "npm-global":
    case "pnpm-global":
    case "yarn-global":
    case "bun-global":
      sourceDesc = source;
      break;
    case "homebrew":
      sourceDesc = "homebrew";
      break;
    case "native":
      sourceDesc =
        "native (windows). Auto-update is not supported on this platform.";
      break;
    case "unsupported":
      sourceDesc = "unsupported package manager or layout.";
      break;
  }
  return (
    `A newer version of ${NPM_PACKAGE_NAME} is available ` +
    `(${currentVersion} -> ${target.version}).\n` +
    `Detected install source: ${sourceDesc}\n` +
    `To update manually, run: ${installCommand}\n` +
    (source === "homebrew" ? THIRD_PARTY_SOURCE_NOTE : "")
  );
}

export function renderInstallSuccessMessage(target: UpdateTarget): string {
  return `Updated ${NPM_PACKAGE_NAME} to ${target.version}. Restart the CLI to use the new version.\n`;
}

export async function installUpdate(
  source: InstallSource,
  version: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const { cmd, args } = spawnForSource(source, version, platform);
  await new Promise<void>((resolve, reject) => {
    // Windows package managers (npm/pnpm/yarn) are .cmd shims. Since the
    // CVE-2024-27980 fix, Node throws EINVAL when spawning a .cmd/.bat without
    // a shell, so run through the shell on win32. The version is a validated
    // semver and the package name is a constant, so args are shell-safe.
    const child = spawn(cmd, [...args], {
      stdio: "inherit",
      shell: platform === "win32" ? true : undefined,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail =
        signal !== null ? `signal ${signal}` : `code ${String(code)}`;
      reject(new Error(`${cmd} exited with ${detail}`));
    });
  });
}
