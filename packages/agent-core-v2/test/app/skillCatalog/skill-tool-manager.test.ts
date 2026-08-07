import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "pathe";

import type { ToolCall } from "#/kosong/contract/message";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IAgentContextMemoryService } from "#/agent/contextMemory/contextMemory";
import { IEventBus } from "#/app/event/eventBus";
import { IAgentProfileService } from "#/agent/profile/profile";
import { InMemorySkillCatalog } from "#/app/skillCatalog/registry";
import {
  type SkillCatalog,
  type SkillDefinition,
} from "#/app/skillCatalog/types";
