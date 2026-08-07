/**
 * `globalSearch` — global cross-session message search. Mirrors
 * `agent-core-v2/app/search/contract.ts`.
 */

import { z } from "zod";

import type { ServiceContract } from "../types.js";

export const globalSearchQuerySchema = z.object({
  query: z.string().min(1),
  mode: z.enum(["terms", "literal"]).optional(),
  op: z.enum(["AND", "OR"]).optional(),
  container: z
    .object({
      sessionId: z.string().min(1).optional(),
      agentId: z.string().min(1).optional(),
    })
    .optional(),
  role: z.enum(["user", "assistant", "title"]).optional(),
  startTime: z.number().int().nonnegative().optional(),
  endTime: z.number().int().nonnegative().optional(),
  sort: z.enum(["score", "time_desc", "time_asc"]).optional(),
  pageSize: z.number().int().min(1).max(50).optional(),
  pageToken: z.string().min(1).optional(),
});

export const globalSearchHitSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  sessionTitle: z.string(),
  agentId: z.string(),
  role: z.enum(["user", "assistant", "title"]),
  snippet: z.string(),
  time: z.number(),
  turn: z.number().int().nonnegative().optional(),
  stepId: z.string().optional(),
  score: z.number(),
});

export const globalSearchPageSchema = z.object({
  items: z.array(globalSearchHitSchema),
  hasMore: z.boolean(),
  pageToken: z.string().optional(),
  incomplete: z
    .enum(["candidate_cap", "postings_budget", "deadline"])
    .optional(),
  indexState: z.object({
    state: z.enum(["building", "ready", "readonly"]),
    indexedSessions: z.number(),
    totalSessions: z.number(),
    documents: z.number(),
    stale: z.boolean().optional(),
    degraded: z.string().optional(),
  }),
  source: z.enum(["index", "ripgrep"]),
});

export const globalSearchContract = {
  search: {
    input: z.tuple([globalSearchQuerySchema]),
    output: globalSearchPageSchema,
  },
  reindex: {
    input: z.tuple([]),
    output: z.object({
      sessions: z.number(),
      documents: z.number(),
    }),
  },
  status: {
    input: z.tuple([]),
    output: z.object({
      sessions: z.number(),
      documents: z.number(),
      lastIndexedAt: z.number().nullable(),
      generation: z.number(),
      degraded: z.string().optional(),
    }),
  },
} satisfies ServiceContract;
