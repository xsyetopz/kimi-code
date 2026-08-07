/**
 * Scenario: App-scope harness interceptor registry and agent-scope wiring into
 * existing hook slots.
 *
 * Run: `bunx vitest run packages/agent-core-v2/test/app/harnessInterceptor/harnessInterceptor.test.ts`.
 */

import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { DisposableStore } from "#/_base/di/lifecycle";
import { createServices } from "#/_base/di/test";
import { Event } from "#/_base/event";
import { IAgentContextMemoryService } from "#/agent/contextMemory/contextMemory";
import type { ContextMessage } from "#/agent/contextMemory/types";
import { AgentHarnessInterceptorService } from "#/agent/harnessInterceptor/harnessInterceptorService";
import { IAgentHarnessInterceptorService } from "#/agent/harnessInterceptor/harnessInterceptor";
import { IAgentFullCompactionService } from "#/agent/fullCompaction/fullCompaction";
import { IAgentLoopService } from "#/agent/loop/loop";
import { IAgentPromptService } from "#/agent/prompt/prompt";
import { AgentPromptService } from "#/agent/prompt/promptService";
import { IAgentSystemReminderService } from "#/agent/systemReminder/systemReminder";
import { AgentSystemReminderService } from "#/agent/systemReminder/systemReminderService";
import { denyToolExecution } from "#/agent/toolExecutor/beforeToolExecuteEvent";
import type { BeforeToolExecuteEvent } from "#/agent/toolExecutor/toolHooks";
import { IAgentToolExecutorService } from "#/agent/toolExecutor/toolExecutor";
import { AgentToolExecutorService } from "#/agent/toolExecutor/toolExecutorService";
import { IAgentToolRegistryService } from "#/agent/toolRegistry/toolRegistry";
import { AgentToolRegistryService } from "#/agent/toolRegistry/toolRegistryService";
import { HarnessInterceptorRegistryService } from "#/app/harnessInterceptor/harnessInterceptorRegistryService";
import { IHarnessInterceptorRegistry } from "#/app/harnessInterceptor/harnessInterceptorRegistry";
import { IEventBus } from "#/app/event/eventBus";
import { EventBusService } from "#/app/event/eventBusService";
import { BugIndicatingError } from "#/errors";
import { createHooks } from "#/hooks";
import { IWireService } from "#/wire/wire";

import { registerLogServices } from "../../_base/log/stubs";
import { stubContextMemory } from "../../agent/contextMemory/stubs";
import { stubLoopWithHooks } from "../../agent/loop/stubs";
import { stubToolExecutorEvents } from "../../agent/toolExecutor/stubs";
import { registerToolResultTruncationServices } from "../../agent/toolResultTruncation/stubs";
import { registerStateServices } from "../../state/stubs";
