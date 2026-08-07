import { readFile } from "node:fs/promises";

import {
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IBootstrapService,
  ISessionIndex,
  ISessionLifecycleService,
  IWorkspaceLifecycleService,
  ensureMainAgent,
  parseAgentFileText,
  resolveAgentPath,
  resumeSessionById,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  type Scope,
} from "@moonshot-ai/kimi-code-sdk";
import { resolve } from "pathe";

import { configuredModel, requireConfiguredModel } from "../run-prompt";
import type { CLIOptions } from "../options";
import type { PromptOutput } from "../prompt-render";

export interface ResolvedNativeSession {
  readonly session: ISessionScopeHandle;
  readonly agent: IAgentScopeHandle;
  readonly restorePermission: () => Promise<void>;
  readonly goalModel: string | undefined;
}

export async function resolveNativeSession(
  app: Scope,
  opts: CLIOptions,
  workDir: string,
  defaultModel: string | undefined,
  stderr: PromptOutput,
): Promise<ResolvedNativeSession> {
  const workspaceLifecycle = app.accessor.get(IWorkspaceLifecycleService);
  const index = app.accessor.get(ISessionIndex);

  // `--agent` selects a catalog profile by name; otherwise `--agent-file`
  // implicitly selects the profile that file defines. The file
  // is parsed here (fatal on error) so a bad file fails before any turn.
  let agentProfileName = opts.agent;
  const agentFile = opts.agentFiles[0];
  if (agentProfileName === undefined && agentFile !== undefined) {
    const agentFilePath = resolveAgentPath(
      agentFile,
      workDir,
      app.accessor.get(IBootstrapService).osHomeDir,
    );
    let agentFileText: string;
    try {
      agentFileText = await readFile(agentFilePath, "utf8");
    } catch (error) {
      throw new Error(
        `Failed to read agent file "${agentFilePath}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    try {
      agentProfileName = parseAgentFileText({
        path: agentFilePath,
        source: "explicit",
        text: agentFileText,
      }).name;
    } catch (error) {
      throw new Error(
        `Invalid agent file "${agentFilePath}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  // `--agent` / `--agent-file` are creation-only: validateOptions rejects them
  // together with --session/--continue, so resume paths only apply an
  // explicitly requested model — the bound profile is restored by the engine.
  const applyModelOverride = async (
    profile: IAgentProfileService,
    model: string | undefined,
  ): Promise<void> => {
    if (model !== undefined) await profile.setModel(model);
  };

  const resumeById = async (id: string): Promise<ISessionScopeHandle> => {
    const session = await resumeSessionById(app.accessor, id);
    if (session === undefined) {
      throw new Error(`Session "${id}" not found.`);
    }
    return session;
  };

  const forceAuto = (
    agent: IAgentScopeHandle,
  ): { readonly restorePermission: () => Promise<void> } => {
    const permissionMode = agent.accessor.get(IAgentPermissionModeService);
    const previous = permissionMode.mode;
    permissionMode.setMode("auto");
    return {
      restorePermission: async () => {
        permissionMode.setMode(previous);
      },
    };
  };

  if (opts.session !== undefined) {
    const target = await index.get(opts.session);
    if (target === undefined) {
      throw new Error(`Session "${opts.session}" not found.`);
    }
    if (target.cwd !== undefined && resolve(target.cwd) !== resolve(workDir)) {
      stderr.write(
        `Session "${opts.session}" was created under a different directory.\n` +
          `  cd "${target.cwd}" && kimi -r ${opts.session}\n\n`,
      );
      throw new Error(
        `Session "${opts.session}" was created under a different directory.`,
      );
    }
    const session = await resumeById(opts.session);
    const agent = await ensureMainAgent(session);
    const profile = agent.accessor.get(IAgentProfileService);
    await applyModelOverride(profile, opts.model);
    const currentModel = profile.getModel();
    const { restorePermission } = forceAuto(agent);
    return {
      session,
      agent,
      restorePermission,
      goalModel: configuredModel(opts.model, currentModel),
    };
  }

  if (opts.continue) {
    const page = await index.listRecent({});
    const previous = page.items.find((summary) => summary.cwd === workDir);
    if (previous !== undefined) {
      const session = await resumeById(previous.id);
      const agent = await ensureMainAgent(session);
      const profile = agent.accessor.get(IAgentProfileService);
      await applyModelOverride(profile, opts.model);
      const currentModel = profile.getModel();
      const { restorePermission } = forceAuto(agent);
      return {
        session,
        agent,
        restorePermission,
        goalModel: configuredModel(opts.model, currentModel),
      };
    }
    stderr.write(
      `No sessions to continue under "${workDir}"; starting a fresh session.\n`,
    );
  }

  const model = requireConfiguredModel(opts.model, defaultModel);
  const handler = await workspaceLifecycle.handlerFor({ root: workDir });
  const session = await handler.accessor.get(ISessionLifecycleService).create({
    workDir,
    additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
    mainAgentBinding: {
      profile: agentProfileName ?? "agent",
      model,
    },
  });
  const agent = await ensureMainAgent(session);
  agent.accessor.get(IAgentPermissionModeService).setMode("auto");
  return {
    session,
    agent,
    restorePermission: async () => {},
    goalModel: model,
  };
}
