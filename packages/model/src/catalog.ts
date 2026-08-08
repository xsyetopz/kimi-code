import { HAND_PROFILES } from "./hand-profiles";
import snapshotData from "./catalog-snapshot.json";
import { snapshotModelToProfile } from "./snapshot-to-profile";
import type { CatalogSnapshot } from "./snapshot-types";
import type { ModelProfile } from "./profile";

function buildCatalog(): readonly ModelProfile[] {
  const snapshot = snapshotData as CatalogSnapshot;
  const byId = new Map<string, ModelProfile>();

  for (const entry of snapshot.models) {
    byId.set(entry.id, snapshotModelToProfile(entry));
  }

  for (const profile of HAND_PROFILES) {
    byId.set(profile.id, profile);
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const CATALOG = buildCatalog();
const byId = new Map(CATALOG.map((profile) => [profile.id, profile]));

export function listModels(): readonly ModelProfile[] {
  return CATALOG;
}

export function resolveModel(id: string): ModelProfile {
  const profile = byId.get(id);
  if (!profile) {
    throw new ModelNotFoundError(id);
  }
  return profile;
}

export class ModelNotFoundError extends Error {
  readonly code = "MODEL_NOT_FOUND" as const;

  constructor(readonly modelId: string) {
    super(`Unknown model id: ${modelId}`);
    this.name = "ModelNotFoundError";
  }
}
