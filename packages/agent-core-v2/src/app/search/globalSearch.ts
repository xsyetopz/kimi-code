/**
 * `search` domain — `IGlobalSearchService` contract and query errors.
 */

import {
  createDecorator,
  type ServiceIdentifier,
} from "#/_base/di/instantiation";

import type { GlobalSearchPage, GlobalSearchQuery } from "./contract";

export type GlobalSearchErrorReason =
  | "invalid_query"
  | "invalid_page_token"
  | "readonly_index"
  | "index_unavailable";

export class GlobalSearchError extends Error {
  constructor(
    readonly reason: GlobalSearchErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "GlobalSearchError";
  }
}

export interface IGlobalSearchService {
  readonly _serviceBrand: undefined;
  search(query: GlobalSearchQuery): Promise<GlobalSearchPage>;
  reindex(): Promise<{ sessions: number; documents: number }>;
  status(): Promise<{
    sessions: number;
    documents: number;
    lastIndexedAt: number | null;
    generation: number;
    degraded?: string;
  }>;
}

export const IGlobalSearchService: ServiceIdentifier<IGlobalSearchService> =
  createDecorator<IGlobalSearchService>("globalSearch");
