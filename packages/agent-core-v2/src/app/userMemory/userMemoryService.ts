/**
 * `userMemory` domain — `IUserMemoryService` implementation.
 *
 * Persists the append-only `CURRENT` buffer and topic documents through
 * `IFileSystemStorageService`, addressed under `bootstrap.scope('memory')`.
 * Recall formatting is delegated to the pure `userMemoryRecall` helpers.
 * Bound at App scope.
 */

import { TextDecoder, TextEncoder } from "node:util";

import { Disposable } from "#/_base/di/lifecycle";
import { LifecycleScope, ScopeActivation, registerScopedService } from "#/_base/di/scope";
import { IBootstrapService } from "#/app/bootstrap/bootstrap";
import { IFileSystemStorageService } from "#/persistence/interface/storage";

import {
  DEFAULT_USER_MEMORY_RECALL_MAX_TOKENS,
  IUserMemoryService,
  USER_MEMORY_CURRENT_KEY,
  USER_MEMORY_TOPICS_SCOPE,
  type UserMemoryAppendInput,
  type UserMemoryRecall,
  type UserMemoryTopicExcerpt,
} from "./userMemory";
import {
  formatMemoryRecallBlock,
  sanitizeTopicSlug,
  truncateToTokenBudget,
} from "./userMemoryRecall";

const TOPIC_SUFFIX = ".md";
const MAX_TOPIC_DOCS = 3;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class UserMemoryService extends Disposable implements IUserMemoryService {
  declare readonly _serviceBrand: undefined;

  private readonly memoryScope: string;

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
  ) {
    super();
    this.memoryScope = bootstrap.scope("memory");
  }

  async append(input: UserMemoryAppendInput): Promise<void> {
    const text = input.text.trim();
    if (text.length === 0) return;
    const source = input.source ?? "manual";
    const line = `- [${new Date().toISOString()}] (source=${source}) ${text}\n`;
    await this.storage.append(this.memoryScope, USER_MEMORY_CURRENT_KEY, encoder.encode(line), {
      durable: true,
    });
  }

  async appendTopic(topic: string, text: string): Promise<void> {
    const body = text.trim();
    if (body.length === 0) return;
    const slug = sanitizeTopicSlug(topic);
    const line = `- [${new Date().toISOString()}] ${body}\n`;
    await this.storage.append(
      USER_MEMORY_TOPICS_SCOPE,
      `${slug}${TOPIC_SUFFIX}`,
      encoder.encode(line),
      { durable: true },
    );
  }

  async readRecall(maxTokens = DEFAULT_USER_MEMORY_RECALL_MAX_TOKENS): Promise<UserMemoryRecall> {
    const currentBytes = await this.storage.read(this.memoryScope, USER_MEMORY_CURRENT_KEY);
    const current = currentBytes === undefined ? "" : decoder.decode(currentBytes);
    const topicKeys = (await this.storage.list(USER_MEMORY_TOPICS_SCOPE))
      .filter((key) => key.endsWith(TOPIC_SUFFIX))
      .toSorted();
    const topics: UserMemoryTopicExcerpt[] = [];
    for (const key of topicKeys.slice(-MAX_TOPIC_DOCS)) {
      const bytes = await this.storage.read(USER_MEMORY_TOPICS_SCOPE, key);
      if (bytes === undefined) continue;
      const text = decoder.decode(bytes).trim();
      if (text.length === 0) continue;
      topics.push({
        name: key.slice(0, -TOPIC_SUFFIX.length),
        text,
      });
    }
    const currentBudget = Math.max(
      0,
      maxTokens - topics.reduce((sum, topic) => sum + Math.ceil(topic.text.length / 4), 0),
    );
    return {
      current: truncateToTokenBudget(current, currentBudget),
      topics,
    };
  }

  async formatRecallForInjection(
    maxTokens = DEFAULT_USER_MEMORY_RECALL_MAX_TOKENS,
  ): Promise<string | undefined> {
    const recall = await this.readRecall(maxTokens);
    return formatMemoryRecallBlock(recall, maxTokens);
  }
}

registerScopedService(
  LifecycleScope.App,
  IUserMemoryService,
  UserMemoryService,
  ScopeActivation.OnScopeCreated,
  "userMemory",
);
