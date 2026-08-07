/**
 * `skill` domain — `IAgentSkillService` implementation.
 *
 * Resolves skills from the session catalog, renders the activation prompt,
 * records the activation as a `skill.activate` fact through `wire.dispatch`
 * (a stateless, identity-apply Op), derives the `skill.activated` event
 * through the Op's `toEvent`, drives user-slash activations into a new turn via
 * `prompt`. `wire.replay` reapplies the fact as a no-op, so the event does not
 * fire on resume (matching the former `restoring` guard). Bound at
 * Agent scope.
 */

import { randomUUID } from "node:crypto";
import {
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from "#/_base/di/scope";

import type { ContentPart } from "#/kosong/contract/message";

import type {
  ContextMessage,
  SkillActivationOrigin,
} from "#/agent/contextMemory/types";
import { USER_PROMPT_ORIGIN } from "#/agent/contextMemory/types";
import { IAgentContextMemoryService } from "#/agent/contextMemory/contextMemory";
import { renderUserSlashSkillPrompt } from "./prompt";
import { ISessionContext } from "#/session/sessionContext/sessionContext";
import { Disposable } from "#/_base/di/lifecycle";
import { ErrorCodes, Error2 } from "#/errors";
import {
  isUserActivatableSkillType,
  type SkillDefinition,
} from "#/app/skillCatalog/types";
import { IAgentPromptService } from "#/agent/prompt/prompt";
import type { Turn } from "#/agent/loop/loop";
import { IWireService } from "#/wire/wire";
import { IAgentSkillService, type SkillActivationInput } from "./skill";
import { skillActivate } from "./skillOps";
import { stripInlineSkillTokens } from "./inlinePrompt";
import { ISessionSkillCatalog } from "#/session/sessionSkillCatalog/skillCatalog";

export class AgentSkillService
  extends Disposable
  implements IAgentSkillService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IWireService private readonly wire: IWireService,    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentContextMemoryService
    private readonly context: IAgentContextMemoryService,
  ) {
    super();
  }

  async activate(input: SkillActivationInput): Promise<Turn> {
    await this.skillCatalog.ready;
    const skill = this.skillCatalog.catalog.getSkill(input.name);
    if (skill === undefined) {
      throw new Error2(
        ErrorCodes.SKILL_NOT_FOUND,
        `Skill "${input.name}" was not found`,
      );
    }
    if (!isUserActivatableSkillType(skill.metadata.type)) {
      throw new Error2(
        ErrorCodes.SKILL_TYPE_UNSUPPORTED,
        `Skill "${skill.name}" cannot be activated by the user`,
      );
    }

    const skillArgs = input.args ?? "";
    const skillContent = this.renderSkillPrompt(skill, skillArgs);
    const content: ContentPart[] = [
      {
        type: "text",
        text: renderUserSlashSkillPrompt({
          skillName: skill.name,
          skillArgs,
          skillContent,
          skillSource: skill.source,
          skillDir: skill.dir,
        }),
      },
    ];

    const turn = await this.recordActivation(
      {
        kind: "skill_activation",
        activationId: randomUUID(),
        skillName: skill.name,
        trigger: "user-slash",
        skillType: skill.metadata.type,
        skillPath: skill.path,
        skillSource: skill.source,
        skillArgs: input.args,
      },
      content,
    );
    if (turn === undefined) {
      throw new Error2(
        ErrorCodes.TURN_AGENT_BUSY,
        "Cannot activate skill while another turn is active",
      );
    }
    return turn;
  }

  async activateInline(
    invocations: readonly SkillActivationInput[],
    userText: string,
  ): Promise<Turn> {
    if (invocations.length === 0) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        "inline skill invocations must not be empty",
      );
    }
    await this.skillCatalog.ready;
    const skillMessages: ContextMessage[] = [];
    for (const input of invocations) {
      const skill = this.skillCatalog.catalog.getSkill(input.name);
      if (skill === undefined) {
        throw new Error2(
          ErrorCodes.SKILL_NOT_FOUND,
          `Skill "${input.name}" was not found`,
        );
      }
      if (!isUserActivatableSkillType(skill.metadata.type)) {
        throw new Error2(
          ErrorCodes.SKILL_TYPE_UNSUPPORTED,
          `Skill "${skill.name}" cannot be activated by the user`,
        );
      }
      const skillArgs = input.args ?? "";
      const skillContent = this.renderSkillPrompt(skill, skillArgs);
      const origin: SkillActivationOrigin = {
        kind: "skill_activation",
        activationId: randomUUID(),
        skillName: skill.name,
        trigger: "user-slash",
        skillType: skill.metadata.type,
        skillPath: skill.path,
        skillSource: skill.source,
        skillArgs: input.args,
      };
      this.wire.dispatch(skillActivate({ origin }));
      this.publishActivation(origin);
      skillMessages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: renderUserSlashSkillPrompt({
              skillName: skill.name,
              skillArgs,
              skillContent,
              skillSource: skill.source,
              skillDir: skill.dir,
            }),
          },
        ],
        toolCalls: [],
        origin,
      });
    }

    const stripped = stripInlineSkillTokens(userText);
    const lastMessage = skillMessages[skillMessages.length - 1]!;

    if (stripped.length === 0) {
      for (const message of skillMessages.slice(0, -1)) {
        this.context.append(message);
      }
      const turn = (await this.prompt.enqueue({ message: lastMessage }))
        .launched;
      if (turn === undefined) {
        throw new Error2(
          ErrorCodes.TURN_AGENT_BUSY,
          "Cannot activate skill while another turn is active",
        );
      }
      return turn;
    }

    for (const message of skillMessages) {
      this.context.append(message);
    }
    const userMessage: ContextMessage = {
      role: "user",
      content: [{ type: "text", text: stripped }],
      toolCalls: [],
      origin: USER_PROMPT_ORIGIN,
    };
    const turn = (await this.prompt.enqueue({ message: userMessage })).launched;
    if (turn === undefined) {
      throw new Error2(
        ErrorCodes.TURN_AGENT_BUSY,
        "Cannot activate skill while another turn is active",
      );
    }
    return turn;
  }

  recordModelToolActivation(origin: SkillActivationOrigin): void {
    void this.recordActivation(origin);
  }

  private async recordActivation(
    origin: SkillActivationOrigin,
    input?: readonly ContentPart[],
  ): Promise<Turn | undefined> {
    this.wire.dispatch(skillActivate({ origin }));
    this.publishActivation(origin);

    if (input === undefined) return undefined;
    const message: ContextMessage = {
      role: "user",
      content: [...input],
      toolCalls: [],
      origin,
    };
    return (await this.prompt.enqueue({ message })).launched;
  }

  private renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string {
    return this.skillCatalog.catalog.renderSkillPrompt(skill, rawArgs, {
      sessionId: this.sessionContext.sessionId,
    });
  }

  private publishActivation(origin: SkillActivationOrigin): void {
    if (origin.skillType === "flow") {
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSkillService,
  AgentSkillService,
  ScopeActivation.OnScopeCreated,
  "skill",
);
