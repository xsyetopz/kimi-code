/**
 * v1-shaped `config.toml` zod schema for the public SDK boundary.
 *
 * Known domains use the same section schemas as agent-core-v2; unknown
 * top-level keys are preserved via passthrough for forward compatibility.
 */

import { z } from "zod";

import {
  HookDefSchema,
  HooksConfigSchema,
} from "@moonshot-ai/agent-core-v2/agent/externalHooks/configSection";
import { ImageConfigSchema } from "@moonshot-ai/agent-core-v2/agent/media/configSection";
import { PermissionConfigSchema } from "@moonshot-ai/agent-core-v2/agent/permissionRules/configSection";
import { AgentTaskConfigSchema } from "@moonshot-ai/agent-core-v2/agent/task/configSection";
import { ServicesConfigSchema } from "@moonshot-ai/agent-core-v2/app/auth/configSection";
import { ExperimentalConfigSchema } from "@moonshot-ai/agent-core-v2/app/flag/flag";
import {
  ModelCatalogConfigSchema,
  ModelRecordSchema,
  ModelsSectionSchema,
  ProviderConfigSchema,
  ProvidersSectionSchema,
  SecondaryModelConfigSchema,
  ThinkingConfigSchema,
} from "@moonshot-ai/agent-core-v2/app/kosongConfig/configSection";
import { McpSectionSchema } from "@moonshot-ai/agent-core-v2/app/mcpConfig/configSection";
import {
  ExtraSkillDirsConfigSchema,
  MergeAllAvailableSkillsConfigSchema,
} from "@moonshot-ai/agent-core-v2/app/skillCatalog/configSection";
import { SubagentConfigSchema } from "@moonshot-ai/agent-core-v2/session/subagent/configSection";
import { SwarmConfigSchema } from "@moonshot-ai/agent-core-v2/session/swarm/configSection";

export { HookDefSchema, ProviderConfigSchema };
export const ModelAliasSchema = ModelRecordSchema;

export const KimiConfigSchema = z
  .object({
    providers: ProvidersSectionSchema.optional(),
    models: ModelsSectionSchema.optional(),
    thinking: ThinkingConfigSchema.optional(),
    secondaryModel: SecondaryModelConfigSchema.optional(),
    modelCatalog: ModelCatalogConfigSchema.optional(),
    permission: PermissionConfigSchema.optional(),
    hooks: HooksConfigSchema.optional(),
    services: ServicesConfigSchema.optional(),
    mcp: McpSectionSchema.optional(),
    image: ImageConfigSchema.optional(),
    background: AgentTaskConfigSchema.optional(),
    subagent: SubagentConfigSchema.optional(),
    swarm: SwarmConfigSchema.optional(),
    experimental: ExperimentalConfigSchema.optional(),
    extraSkillDirs: ExtraSkillDirsConfigSchema.optional(),
    mergeAllAvailableSkills: MergeAllAvailableSkillsConfigSchema.optional(),
    defaultModel: z.string().optional(),
    defaultProvider: z.string().optional(),
    defaultPermissionMode: z.string().optional(),
    defaultPlanMode: z.boolean().optional(),
    planMode: z.boolean().optional(),
    yolo: z.boolean().optional(),
  })
  .passthrough();
