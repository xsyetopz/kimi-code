import type { TransportId } from "./profile";

/** Slim models.dev snapshot entry written by scripts/refresh-catalog.mjs. */
export interface CatalogSnapshotModel {
  readonly id: string;
  readonly displayName: string;
  readonly wireModel: string;
  readonly transport: TransportId;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  readonly images: boolean;
  readonly toolCalls: boolean;
  readonly reasoning: boolean;
  readonly temperature: boolean;
}

export interface CatalogSnapshot {
  readonly version: 1;
  readonly fetchedAt: string;
  readonly source: string;
  readonly models: readonly CatalogSnapshotModel[];
}
