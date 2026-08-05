import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getEmbeddedNativeAssetManifest,
  getNativeCacheBase,
  getNativePackageRoot,
  getNativeRuntimeFile,
  NATIVE_ASSET_MANIFEST_VERSION,
  type NativeAssetManifest,
  type NativeAssetSource,
} from "#/native/native-assets";
import { loadNativePackage } from "#/native/native-require";

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fakeManifest(
  files: Record<string, string>,
  runtimeFileContent?: string,
): {
  manifest: NativeAssetManifest;
  source: NativeAssetSource;
} {
  const assetEntries = Object.entries(files).map(([relativePath, content]) => {
    const assetKey = `native/test-target/${relativePath}`;
    return {
      assetKey,
      relativePath,
      sha256: sha256(content),
    };
  });
  const manifestKey = "native/test-target/manifest.json";
  const runtimeAssetKey = "native/test-target/runtime/fake-runtime-file";
  const manifest: NativeAssetManifest = {
    version: NATIVE_ASSET_MANIFEST_VERSION,
    target: "test-target",
    packages: [
      {
        name: "fake-native",
        root: "node_modules/fake-native",
        files: assetEntries,
      },
    ],
    runtimeFiles:
      runtimeFileContent === undefined
        ? []
        : [
            {
              key: "fake-runtime-file",
              assetKey: runtimeAssetKey,
              relativePath: "runtime/fake-runtime-file.mjs",
              sha256: sha256(runtimeFileContent),
              mode: 0o644,
            },
          ],
  };
  const assets = new Map<string, Buffer>([
    [manifestKey, Buffer.from(JSON.stringify(manifest))],
    ...Object.entries(files).map(
      ([relativePath, content]) =>
        [`native/test-target/${relativePath}`, Buffer.from(content)] as const,
    ),
    ...(runtimeFileContent === undefined
      ? []
      : [[runtimeAssetKey, Buffer.from(runtimeFileContent)] as const]),
  ]);
  return {
    manifest,
    source: {
      getAssetKeys: () => [...assets.keys()],
      getRawAsset: (assetKey) => {
        const asset = assets.get(assetKey);
        if (asset === undefined)
          throw new Error(`missing test asset: ${assetKey}`);
        return asset;
      },
    },
  };
}

function sourceForManifest(manifest: unknown): NativeAssetSource {
  const key = "native/test-target/manifest.json";
  return {
    getAssetKeys: () => [key],
    getRawAsset: (assetKey) => {
      if (assetKey !== key) throw new Error(`missing test asset: ${assetKey}`);
      return Buffer.from(JSON.stringify(manifest));
    },
  };
}

describe("native assets", () => {
  it("uses KIMI_CODE_CACHE_DIR as the native cache base when present", () => {
    expect(
      getNativeCacheBase({
        env: { KIMI_CODE_CACHE_DIR: "/tmp/kimi-cache" },
        homeDir: "/home/kimi",
        platform: "linux",
      }),
    ).toBe("/tmp/kimi-cache");
  });

  it("extracts package assets and repairs corrupted cache files", () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-native-assets-"));
    try {
      const { manifest, source } = fakeManifest({
        "node_modules/fake-native/package.json": '{"main":"index.js"}',
        "node_modules/fake-native/index.js":
          "module.exports = { value: 'ok' };\n",
      });

      const packageRoot = getNativePackageRoot("fake-native", {
        cacheBase: dir,
        manifest,
        source,
        version: "test",
      });
      expect(packageRoot).toBe(
        join(
          dir,
          "native",
          "test",
          "test-target",
          sha256(JSON.stringify(manifest)),
          "node_modules",
          "fake-native",
        ),
      );
      expect(
        readFileSync(join(packageRoot ?? "", "index.js"), "utf-8"),
      ).toContain("value: 'ok'");

      writeFileSync(join(packageRoot ?? "", "index.js"), "broken");
      const repairedRoot = getNativePackageRoot("fake-native", {
        cacheBase: dir,
        manifest,
        source,
        version: "test",
      });
      expect(repairedRoot).toBe(packageRoot);
      expect(
        readFileSync(join(repairedRoot ?? "", "index.js"), "utf-8"),
      ).toContain("value: 'ok'");
      expect(existsSync(join(dir, "native", "test", "test-target"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads a package from extracted native assets", () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-native-require-"));
    try {
      const { manifest, source } = fakeManifest({
        "node_modules/fake-native/package.json": '{"main":"index.js"}',
        "node_modules/fake-native/index.js":
          "module.exports = { value: 'ok' };\n",
      });

      const pkg = loadNativePackage<{ value: string }>("fake-native", {
        cacheBase: dir,
        manifest,
        source,
        version: "test",
      });

      expect(pkg).toEqual({ value: "ok" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts, reuses, and repairs runtime files in the unified cache tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-native-runtime-"));
    try {
      const runtime = "export const runtime = true;\n";
      const { manifest, source } = fakeManifest(
        { "node_modules/fake-native/package.json": '{"main":"index.js"}' },
        runtime,
      );
      const options = { cacheBase: dir, manifest, source, version: "test" };
      const first = getNativeRuntimeFile("fake-runtime-file", options);
      const packageRoot = getNativePackageRoot("fake-native", options);
      expect(first).toBe(
        join(
          dir,
          "native",
          "test",
          "test-target",
          sha256(JSON.stringify(manifest)),
          "runtime",
          "fake-runtime-file.mjs",
        ),
      );
      expect(
        packageRoot?.startsWith(join(dir, "native", "test", "test-target")),
      ).toBe(true);
      expect(getNativeRuntimeFile("fake-runtime-file", options)).toBe(first);

      writeFileSync(first!, "corrupt");
      expect(getNativeRuntimeFile("fake-runtime-file", options)).toBe(first);
      expect(readFileSync(first!, "utf-8")).toBe(runtime);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported or structurally incomplete native manifest versions", () => {
    const valid = fakeManifest({}, "worker").manifest;
    const cases: Array<{ manifest: unknown; error: RegExp }> = [
      {
        manifest: { ...valid, version: 1 },
        error: /Unsupported native asset manifest version: 1/,
      },
      {
        manifest: {
          version: NATIVE_ASSET_MANIFEST_VERSION,
          target: "test-target",
          runtimeFiles: [],
        },
        error: /packages must be an array/,
      },
      {
        manifest: {
          version: NATIVE_ASSET_MANIFEST_VERSION,
          target: "test-target",
          packages: [],
        },
        error: /runtimeFiles must be an array/,
      },
      {
        manifest: { ...valid, packages: {} },
        error: /packages must be an array/,
      },
      {
        manifest: { ...valid, runtimeFiles: {} },
        error: /runtimeFiles must be an array/,
      },
    ];

    for (const item of cases) {
      expect(() =>
        getEmbeddedNativeAssetManifest(
          sourceForManifest(item.manifest),
          "test-target",
        ),
      ).toThrow(item.error);
    }
  });

  it("rejects unsafe paths, invalid file metadata, and duplicate manifest keys", () => {
    const valid = fakeManifest({}, "worker").manifest;
    const runtimeFile = valid.runtimeFiles[0]!;
    const invalidRuntimeFiles: Array<{
      file: Record<string, unknown>;
      error: RegExp;
    }> = [
      {
        file: { ...runtimeFile, relativePath: "/tmp/worker.mjs" },
        error: /safe relative path/,
      },
      {
        file: { ...runtimeFile, relativePath: "../worker.mjs" },
        error: /safe relative path/,
      },
      {
        file: { ...runtimeFile, relativePath: "runtime\\..\\worker.mjs" },
        error: /safe relative path/,
      },
      {
        file: { ...runtimeFile, sha256: "not-a-sha" },
        error: /64 lowercase hex/,
      },
      {
        file: { ...runtimeFile, mode: 0o1000 },
        error: /mode must be an integer/,
      },
      {
        file: { ...runtimeFile, assetKey: 42 },
        error: /assetKey must be a non-empty string/,
      },
    ];
    for (const item of invalidRuntimeFiles) {
      expect(() =>
        getEmbeddedNativeAssetManifest(
          sourceForManifest({ ...valid, runtimeFiles: [item.file] }),
          "test-target",
        ),
      ).toThrow(item.error);
    }

    const validPackage = valid.packages[0]!;
    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({
          ...valid,
          packages: [{ ...validPackage, root: "../node_modules/fake-native" }],
        }),
        "test-target",
      ),
    ).toThrow(/safe relative path/);
    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({
          ...valid,
          packages: [{ ...validPackage, files: {} }],
        }),
        "test-target",
      ),
    ).toThrow(/files must be an array/);

    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({
          ...valid,
          runtimeFiles: [
            runtimeFile,
            {
              ...runtimeFile,
              assetKey: "native/test-target/runtime/other",
              relativePath: "runtime/other.mjs",
            },
          ],
        }),
        "test-target",
      ),
    ).toThrow(/duplicate runtime key/);

    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({
          ...valid,
          runtimeFiles: [
            runtimeFile,
            {
              ...runtimeFile,
              key: "other",
              relativePath: "runtime/other.mjs",
            },
          ],
        }),
        "test-target",
      ),
    ).toThrow(/duplicate assetKey/);
  });
});
