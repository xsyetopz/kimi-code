/**
 * AskUserQuestionTool unit tests — ported from v1
 * `packages/agent-core/test/tools/ask-user.test.ts` and adapted to the v2 DI
 * of a fake `Agent`).
 */

import { describe, expect, it, vi } from "vitest";

import { CoreErrors } from "#/_base/errors/codes";
import { Error2 } from "#/_base/errors/errors";
import {
  AskUserQuestionInputSchema,
  type AskUserQuestionInput,
} from "#/agent/tools/ask-user-question/ask-user-question";
import { AskUserQuestionTool } from "#/agent/tools/ask-user-question/askUserQuestionTool";
import { IAgentTaskService } from "#/agent/task/task";
import { IAgentScopeContext } from "#/agent/scopeContext/scopeContext";
import type {
  ISessionQuestionService,
  QuestionRequest,
  QuestionResult,
} from "#/session/question/question";
import type { QuestionBackgroundTask } from "#/agent/tools/ask-user-question/question-background-task";
