/**
 * `llmRequester` domain — LLM request logging and trace helpers.
 */

import { createHash } from 'node:crypto';

import { APIStatusError } from '#/kosong/contract/errors';
import type { Tool } from '#/kosong/contract/tool';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import { unwrapErrorCause } from '#/errors';
import type { PayloadOf } from '#/wire/types';

import {
  type AgentLLMRequestLogFields,
  type AgentLLMRequestSource,
} from './llmRequester';
import { llmRequest, type LlmRequestToolSchema } from './llmRequestOps';


export class MutableLLMRequestTrace implements LLMRequestTrace {
  traceId: string | undefined;

  set(traceId: string | undefined): void {
    this.traceId = traceId;
  }
}

export function logFieldsForSource(source: AgentLLMRequestSource | undefined): AgentLLMRequestLogFields {
  switch (source?.type) {
    case 'turn':
      return {
        ...source.logFields,
        ...(source.step === undefined
          ? {}
          : { turnStep: `${String(source.turnId)}.${String(source.step)}` }),
      };
    case 'operation':
      return {
        ...source.logFields,
        ...(source.requestKind === undefined ? {} : { requestKind: source.requestKind }),
      };
    default:
      return {};
  }
}

export function requestKindForTelemetry(source: AgentLLMRequestSource | undefined): string | undefined {
  if (source?.type === 'turn') return 'turn';
  if (source?.type === 'operation') return source.requestKind ?? 'operation';
  return undefined;
}

export function providerVisibleTools(tools: readonly Tool[]): readonly Tool[] {
  if (!tools.some((tool) => tool.deferred === true)) return tools;
  return tools.filter((tool) => tool.deferred !== true);
}

export function toolSignature(tools: readonly Tool[]): readonly LlmRequestToolSchema[] {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export function requestKindForRecord(fields: AgentLLMRequestLogFields): PayloadOf<typeof llmRequest>['kind'] {
  if (fields['kind'] === 'compaction') return 'compaction';
  if (fields['requestKind'] === 'full_compaction') return 'compaction';
  return 'loop';
}

export function stringField(fields: AgentLLMRequestLogFields, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' ? value : undefined;
}

export function numberField(fields: AgentLLMRequestLogFields, key: string): number | undefined {
  const value = fields[key];
  return typeof value === 'number' ? value : undefined;
}

export function projectionField(
  fields: AgentLLMRequestLogFields,
): 'strict' | 'media-degraded' | 'media-stripped' | undefined {
  const value = fields['projection'];
  return value === 'strict' || value === 'media-degraded' || value === 'media-stripped'
    ? value
    : undefined;
}

export function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function apiStatusCode(error: unknown): number | undefined {
  const raw = unwrapErrorCause(error);
  if (raw instanceof APIStatusError) return raw.statusCode;
  if (typeof raw === 'object' && raw !== null) {
    const statusCode = (raw as Record<string, unknown>)['statusCode'];
    if (typeof statusCode === 'number') return statusCode;
    const status = (raw as Record<string, unknown>)['status'];
    if (typeof status === 'number') return status;
  }
  if (typeof error === 'object' && error !== null) {
    const details = (error as Record<string, unknown>)['details'];
    if (typeof details === 'object' && details !== null) {
      const statusCode = (details as Record<string, unknown>)['statusCode'];
      if (typeof statusCode === 'number') return statusCode;
    }
  }
  return undefined;
}

export function apiTraceId(error: unknown): string | undefined {
  const raw = unwrapErrorCause(error);
  if (raw instanceof APIStatusError && raw.traceId !== null) return raw.traceId;
  if (typeof error === 'object' && error !== null) {
    const details = (error as Record<string, unknown>)['details'];
    if (typeof details === 'object' && details !== null) {
      const traceId = (details as Record<string, unknown>)['traceId'];
      if (typeof traceId === 'string') return traceId;
    }
  }
  return undefined;
}
