export const NATIVE_ASSET_MANIFEST_VERSION = 2;

export function buildManifestKey(target) {
  return `native/${target}/manifest.json`;
}

export function buildRuntimeAssetKey(target, key) {
  return `native/${target}/runtime/${key}`;
}

export function isManifestVersionSupported(version) {
  return version === NATIVE_ASSET_MANIFEST_VERSION;
}

export function buildAssetKey(target, packageRoot, relativePath) {
  return `native/${target}/${packageRoot}/${relativePath}`;
}
