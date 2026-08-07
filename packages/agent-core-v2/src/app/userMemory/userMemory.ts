/**
 * `userMemory` domain — cross-session user memory contract.
 *
 * Infini-Memory-inspired v1 surface: an append-only `CURRENT` buffer plus
 * topic documents under `memory/topics/`. Higher layers stage session facts
 * into the buffer and recall a bounded excerpt at session start. Bound at App
 * scope.
 */

import {
  createDecorator,
  type ServiceIdentifier,
} from "#/_base/di/instantiation";

export const USER_MEMORY_CURRENT_KEY = "CURRENT.md";
export const USER_MEMORY_TOPICS_SCOPE = "memory/topics";
export const DEFAULT_USER_MEMORY_RECALL_MAX_TOKENS = 800;

export interface UserMemoryAppendInput {
  readonly text: string;
  readonly source?: string;
}

export interface UserMemoryTopicExcerpt {
  readonly name: string;
  readonly text: string;
}

export interface UserMemoryRecall {
  readonly current: string;
  readonly topics: readonly UserMemoryTopicExcerpt[];
}

export interface IUserMemoryService {
  readonly _serviceBrand: undefined;

  append(input: UserMemoryAppendInput): Promise<void>;
  appendTopic(topic: string, text: string): Promise<void>;
  readRecall(maxTokens?: number): Promise<UserMemoryRecall>;
  formatRecallForInjection(maxTokens?: number): Promise<string | undefined>;
}

export const IUserMemoryService: ServiceIdentifier<IUserMemoryService> =
  createDecorator<IUserMemoryService>("userMemoryService");
