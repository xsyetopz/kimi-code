/**
 * `plugin` domain — plugin manager install and record helpers.
 */

import { tmpdir } from "node:os";
import path from "node:path";

import { BugIndicatingError, Error2, ErrorCodes, PluginErrors } from "#/errors";
import type { HookDef } from "#/agent/externalHooks/types";
import type { McpServerConfig } from "#/mcpCore/config-schema";
import type { PluginAgentRoot } from "./types";
import { discoverFileSkills } from "#/app/skillCatalog/fileSkillDiscovery";
import type { SkillDiscoveryResult } from "#/app/skillCatalog/skillDiscovery";
import type { SkillRoot } from "#/app/skillCatalog/types";

import { downloadZip, extractZip } from "./archive";
import { loadPluginCommand } from "./commands";
import { resolveGithubCommitSha, resolveGithubSource } from "./github-resolver";
import { resolveInstallSource } from "./source";
import { parseManifest, type ParsedManifestResult } from "./manifest";
import { readInstalled, writeInstalled, type InstalledRecord } from "./store";
import {
  normalizePluginId,
  type EnabledPluginSessionStart,
  type EnabledPluginSystemPrompt,
  type PluginCapabilityState,
  type PluginCommandDef,
  type PluginGithubMetadata,
  type PluginInfo,
  type PluginMcpServerInfo,
  type PluginRecord,
  type PluginSource,
  type PluginSummary,
  type PluginUpdateStatus,
  type ReloadSummary,
} from "./types";

async function installedGithubSha(
  owner: string,
  repo: string,
  ref: PluginGithubMetadata["ref"],
): Promise<string | undefined> {
  if (ref.kind === "sha" && ref.value.length === 40)
    return ref.value.toLowerCase();
  return resolveGithubCommitSha(owner, repo, ref.value);
}

export async function checkGithubUpdate(
  record: PluginRecord,
): Promise<PluginUpdateStatus> {
  const github = record.github;
  if (github === undefined)
    throw new BugIndicatingError(
      `Plugin "${record.id}" has no GitHub metadata`,
    );
  const current = github.ref;
  const pinned = explicitGithubRef(record);

  if (pinned?.kind === "tag" || pinned?.kind === "sha") {
    return {
      id: record.id,
      source: "github",
      current,
      latest: current,
      displayVersion: current.value,
      updateAvailable: false,
    };
  }

  if (pinned?.kind === "branch") {
    const latestSha = await resolveGithubCommitSha(
      github.owner,
      github.repo,
      pinned.value,
    );
    return {
      id: record.id,
      source: "github",
      current,
      latest: current,
      displayVersion: latestSha.slice(0, 12),
      updateAvailable:
        github.installedSha === undefined || github.installedSha !== latestSha,
    };
  }

  const latest = await resolveGithubSource({
    kind: "github",
    owner: github.owner,
    repo: github.repo,
  });
  let updateAvailable =
    current.kind !== latest.ref.kind || current.value !== latest.ref.value;
  if (
    !updateAvailable &&
    (latest.ref.kind === "branch" || latest.ref.kind === "tag")
  ) {
    const latestSha = await resolveGithubCommitSha(
      github.owner,
      github.repo,
      latest.ref.value,
    );
    updateAvailable =
      github.installedSha === undefined || github.installedSha !== latestSha;
  }
  return {
    id: record.id,
    source: "github",
    current,
    latest: latest.ref,
    displayVersion: latest.displayVersion,
    updateAvailable,
  };
}

function explicitGithubRef(
  record: PluginRecord,
): PluginGithubMetadata["ref"] | undefined {
  const fallback =
    record.github?.ref.kind === "sha" ||
    (record.github?.ref.kind === "branch" && record.github.ref.value !== "HEAD")
      ? record.github.ref
      : undefined;
  if (record.originalSource === undefined) return fallback;
  try {
    const source = resolveInstallSource(record.originalSource);
    return source.kind === "github" ? source.ref : fallback;
  } catch {
    return fallback;
  }
}

export function pluginNotFound(id: string): Error2 {
  return new Error2(
    PluginErrors.codes.PLUGIN_NOT_FOUND,
    `Plugin "${id}" is not installed`,
    {
      details: { id },
    },
  );
}

export async function normalizeInstallRoot(rootPath: string): Promise<string> {
  const trimmed = rootPath.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `Plugin root must be an absolute path (got "${rootPath}")`,
      { details: { path: rootPath } },
    );
  }
  let resolved: string;
  try {
    resolved = await realpath(trimmed);
  } catch (error) {
    throw new Error2(
      ErrorCodes.FS_PATH_NOT_FOUND,
      `Plugin root does not exist: ${trimmed}`,
      {
        cause: error,
        details: { path: trimmed },
      },
    );
  }
  if (!(await stat(resolved)).isDirectory()) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `Plugin root is not a directory: ${trimmed}`,
      {
        details: { path: trimmed },
      },
    );
  }
  return resolved;
}

export async function copyPluginToManagedRoot(
  kimiHomeDir: string,
  id: string,
  sourceRoot: string,
): Promise<ManagedPluginCopy> {
  const managedRoot = path.join(kimiHomeDir, "plugins", "managed", id);
  const managedDir = path.dirname(managedRoot);
  await mkdir(managedDir, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(managedDir, `${id}-`));
  const previousRoot = `${stagingRoot}-previous`;
  let movedPreviousRoot = false;
  let published = false;
  try {
    await cp(sourceRoot, stagingRoot, { recursive: true });
    try {
      await rename(managedRoot, previousRoot);
      movedPreviousRoot = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(stagingRoot, managedRoot);
    published = true;
    return {
      root: await realpath(managedRoot),
      previousRoot: movedPreviousRoot ? previousRoot : undefined,
    };
  } catch (error) {
    await rm(published ? managedRoot : stagingRoot, {
      recursive: true,
      force: true,
    });
    if (movedPreviousRoot) await rename(previousRoot, managedRoot);
    throw error;
  }
}

export async function rollbackManagedPluginCopy(
  copy: ManagedPluginCopy,
): Promise<void> {
  await rm(copy.root, { recursive: true, force: true });
  if (copy.previousRoot !== undefined) {
    await rename(copy.previousRoot, copy.root);
  }
}

export async function recordFrom(input: {
  id: string;
  root: string;
  enabled: boolean;
  installedAt: string;
  updatedAt?: string;
  originalSource?: string;
  capabilities?: PluginCapabilityState;
  github?: PluginGithubMetadata;
  source?: PluginSource;
  parsed: ParsedManifestResult;
  discoverSkills: (
    roots: readonly SkillRoot[],
  ) => Promise<SkillDiscoveryResult>;
}): Promise<PluginRecord> {
  const { parsed } = input;
  const hasError = parsed.diagnostics.some((d) => d.severity === "error");
  return {
    id: input.id,
    root: input.root,
    source: input.source ?? "local-path",
    enabled: input.enabled,
    state: hasError || parsed.manifest === undefined ? "error" : "ok",
    installedAt: input.installedAt,
    updatedAt: input.updatedAt,
    originalSource: input.originalSource,
    capabilities: input.capabilities,
    github: input.github,
    skillCount: await countDiscoveredPluginSkills(
      input.id,
      parsed.manifest,
      input.discoverSkills,
    ),
    manifest: parsed.manifest,
    manifestKind: parsed.manifestKind,
    manifestPath: parsed.manifestPath,
    shadowedManifestPath: parsed.shadowedManifestPath,
    diagnostics: parsed.diagnostics,
    skillInstructions: parsed.manifest?.skillInstructions,
  };
}

export function recordToSummary(record: PluginRecord): PluginSummary {
  return {
    id: record.id,
    displayName: record.manifest?.interface?.displayName ?? record.id,
    version: record.manifest?.version,
    enabled: record.enabled,
    state: record.state,
    skillCount: record.skillCount,
    mcpServerCount: Object.keys(record.manifest?.mcpServers ?? {}).length,
    enabledMcpServerCount: pluginMcpServersInfo(record).filter(
      (server) => server.enabled,
    ).length,
    hookCount: record.manifest?.hooks?.length ?? 0,
    commandCount: record.manifest?.commands?.length ?? 0,
    hasErrors: record.diagnostics.some((d) => d.severity === "error"),
    source: record.source,
    originalSource: record.originalSource,
    github: record.github,
  };
}

export function recordToInfo(record: PluginRecord): PluginInfo {
  return {
    ...recordToSummary(record),
    root: record.root,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    manifestKind: record.manifestKind,
    manifestPath: record.manifestPath,
    manifest: record.manifest,
    mcpServers: pluginMcpServersInfo(record),
    shadowedManifestPath: record.shadowedManifestPath,
    diagnostics: record.diagnostics,
  };
}

export function isMcpServerEnabled(
  record: PluginRecord,
  name: string,
  config: McpServerConfig,
): boolean {
  return (
    record.capabilities?.mcpServers?.[name]?.enabled ?? config.enabled !== false
  );
}

function pluginMcpServersInfo(
  record: PluginRecord,
): readonly PluginMcpServerInfo[] {
  return Object.entries(record.manifest?.mcpServers ?? {})
    .map(([name, config]) => pluginMcpServerInfo(record, name, config))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

function pluginMcpServerInfo(
  record: PluginRecord,
  name: string,
  config: McpServerConfig,
): PluginMcpServerInfo {
  if (config.transport === "http" || config.transport === "sse") {
    return {
      name,
      runtimeName: pluginMcpRuntimeName(record.id, name),
      enabled: isMcpServerEnabled(record, name, config),
      transport: config.transport,
      url: config.url,
      headerKeys:
        config.headers === undefined
          ? undefined
          : Object.keys(config.headers).toSorted(),
    };
  }
  return {
    name,
    runtimeName: pluginMcpRuntimeName(record.id, name),
    enabled: isMcpServerEnabled(record, name, config),
    transport: "stdio",
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    envKeys:
      config.env === undefined ? undefined : Object.keys(config.env).toSorted(),
  };
}

export function pluginMcpRuntimeName(
  pluginId: string,
  serverName: string,
): string {
  return `plugin-${pluginId}:${serverName}`;
}

const KIMI_NODE_FALLBACK_SUBCOMMAND = "__plugin_run_node";

export function withMcpServerEnabled(
  config: McpServerConfig,
  enabled: boolean,
): McpServerConfig {
  return { ...config, enabled };
}

export function withPluginMcpRuntime(
  config: McpServerConfig,
  pluginRoot: string,
  kimiHomeDir: string,
): McpServerConfig {
  if (config.transport === "http" || config.transport === "sse") return config;

  const env = {
    ...config.env,
    KIMI_CODE_HOME: kimiHomeDir,
    KIMI_PLUGIN_ROOT: pluginRoot,
  };

  if (config.command === "node" && isElectron()) {
    return {
      ...config,
      command: process.execPath,
      args: config.args ?? [],
      cwd: config.cwd ?? pluginRoot,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  if (config.command === "node" && isKimiNativeBinary()) {
    return {
      ...config,
      command: process.execPath,
      args: [KIMI_NODE_FALLBACK_SUBCOMMAND, ...(config.args ?? [])],
      cwd: config.cwd ?? pluginRoot,
      env,
    };
  }

  return { ...config, cwd: config.cwd ?? pluginRoot, env };
}

function isElectron(): boolean {
  return typeof process.versions["electron"] === "string";
}

function isKimiNativeBinary(): boolean {
  return !path.basename(process.execPath).toLowerCase().startsWith("node");
}

async function countDiscoveredPluginSkills(
  pluginId: string,
  manifest: PluginRecord["manifest"],
  discoverSkills: (
    roots: readonly SkillRoot[],
  ) => Promise<SkillDiscoveryResult>,
): Promise<number> {
  const dirs = manifest?.skills ?? [];
  if (dirs.length === 0) return 0;
  const roots: SkillRoot[] = dirs.map((dir) => ({
    path: dir,
    source: "extra",
    plugin: { id: pluginId, instructions: manifest?.skillInstructions },
  }));
  const result = await discoverSkills(roots);
  return result.skills.length;
}
