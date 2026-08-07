/**
 * `plugin` domain — manages installed plugin state and consumption metadata.
 *
 * Installs, reloads, persists, and summarizes plugins, counting loadable
 * plugin skills through skill discovery.
 */

import {
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
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
import {
  checkGithubUpdate,
  installedGithubSha,
  copyPluginToManagedRoot,
  isMcpServerEnabled,
  normalizeInstallRoot,
  pluginMcpRuntimeName,
  pluginNotFound,
  recordFrom,
  recordToInfo,
  recordToSummary,
  rollbackManagedPluginCopy,
  withMcpServerEnabled,
  withPluginMcpRuntime,
} from "./managerHelpers";

export interface PluginManagerOptions {
  readonly kimiHomeDir: string;
  readonly discoverSkills?: (
    roots: readonly SkillRoot[],
  ) => Promise<SkillDiscoveryResult>;
}

interface ManagedPluginCopy {
  readonly root: string;
  readonly previousRoot?: string;
}

export class PluginManager {
  private readonly kimiHomeDir: string;
  private readonly discoverSkills: (
    roots: readonly SkillRoot[],
  ) => Promise<SkillDiscoveryResult>;
  private records = new Map<string, PluginRecord>();

  constructor(options: PluginManagerOptions) {
    this.kimiHomeDir = options.kimiHomeDir;
    this.discoverSkills = options.discoverSkills ?? discoverFileSkills;
  }

  async load(): Promise<void> {
    const file = await readInstalled(this.kimiHomeDir);
    const next = new Map<string, PluginRecord>();
    for (const entry of file.plugins) {
      next.set(entry.id, await this.materialize(entry));
    }
    this.records = next;
  }

  list(): readonly PluginRecord[] {
    return [...this.records.values()].toSorted((a, b) =>
      a.id.localeCompare(b.id),
    );
  }

  get(id: string): PluginRecord | undefined {
    return this.records.get(normalizePluginId(id));
  }

  async install(source: string): Promise<PluginRecord> {
    const resolved = resolveInstallSource(source);

    let sourceRoot: string;
    let originalSource: string;
    let sourceType: PluginSource;
    let zipTmpDir: string | undefined;
    let managedCopy: ManagedPluginCopy | undefined;
    let github: PluginGithubMetadata | undefined;

    try {
      if (resolved.kind === "local-path") {
        sourceRoot = await normalizeInstallRoot(resolved.path);
        originalSource = resolved.path;
        sourceType = "local-path";
      } else {
        originalSource = source.trim();
        sourceType = resolved.kind === "github" ? "github" : "zip-url";
        const zipUrl =
          resolved.kind === "github"
            ? await (async () => {
                const resolution = await resolveGithubSource(resolved);
                const installedSha = await installedGithubSha(
                  resolved.owner,
                  resolved.repo,
                  resolution.ref,
                );
                github = {
                  owner: resolved.owner,
                  repo: resolved.repo,
                  ref: resolution.ref,
                  installedSha,
                };
                if (installedSha !== undefined) {
                  return `https://codeload.github.com/${resolved.owner}/${resolved.repo}/zip/${installedSha}`;
                }
                return resolution.tarballUrl;
              })()
            : resolved.path;
        const buffer = await downloadZip(zipUrl);
        zipTmpDir = await mkdtemp(path.join(tmpdir(), "kimi-plugin-zip-"));
        sourceRoot = await extractZip(buffer, zipTmpDir);
      }

      const parsed = await parseManifest(sourceRoot);
      if (parsed.manifest === undefined) {
        const msg =
          parsed.diagnostics.find((d) => d.severity === "error")?.message ??
          "no manifest";
        throw new Error2(
          ErrorCodes.PLUGIN_LOAD_FAILED,
          sourceType === "local-path"
            ? `Cannot install plugin at ${sourceRoot}: ${msg}`
            : `Cannot install plugin from ${originalSource}: ${msg}`,
          { details: { sourceType } },
        );
      }

      const id = normalizePluginId(parsed.manifest.name);
      managedCopy = await copyPluginToManagedRoot(
        this.kimiHomeDir,
        id,
        sourceRoot,
      );
      const normalizedRoot = managedCopy.root;
      const managedParsed = await parseManifest(normalizedRoot);
      const existing = this.records.get(id);
      const now = new Date().toISOString();
      const record = await recordFrom({
        id,
        root: normalizedRoot,
        enabled: existing?.enabled ?? true,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
        originalSource,
        source: sourceType,
        capabilities: existing?.capabilities,
        github,
        parsed: managedParsed,
        discoverSkills: this.discoverSkills,
      });
      const next = new Map(this.records);
      next.set(id, record);
      await this.persist(next);
      this.records = next;
      if (managedCopy.previousRoot !== undefined) {
        await rm(managedCopy.previousRoot, {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      }
      managedCopy = undefined;
      return record;
    } catch (error) {
      if (managedCopy !== undefined) {
        try {
          await rollbackManagedPluginCopy(managedCopy);
        } catch (rollbackError) {
          throw new Error2(
            ErrorCodes.PLUGIN_LOAD_FAILED,
            "Plugin installation failed and the previous managed copy could not be restored",
            {
              cause: new AggregateError(
                [error, rollbackError],
                "Plugin installation failed and the previous managed copy could not be restored",
                { cause: error },
              ),
            },
          );
        }
      }
      throw error;
    } finally {
      if (zipTmpDir !== undefined) {
        await rm(zipTmpDir, { recursive: true, force: true });
      }
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw pluginNotFound(id);
    if (current.enabled === enabled) return;
    const next = new Map(this.records);
    next.set(key, { ...current, enabled, updatedAt: new Date().toISOString() });
    await this.persist(next);
    this.records = next;
  }

  async setMcpServerEnabled(
    id: string,
    server: string,
    enabled: boolean,
  ): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw pluginNotFound(id);
    if (current.manifest?.mcpServers?.[server] === undefined) {
      throw new Error2(
        ErrorCodes.MCP_SERVER_NOT_FOUND,
        `Plugin "${id}" does not declare MCP server "${server}"`,
        { details: { id, server } },
      );
    }
    const currentMcpServers = current.capabilities?.mcpServers ?? {};
    const nextCapabilities: PluginCapabilityState = {
      ...current.capabilities,
      mcpServers: {
        ...currentMcpServers,
        [server]: { enabled },
      },
    };
    const next = new Map(this.records);
    next.set(key, {
      ...current,
      capabilities: nextCapabilities,
      updatedAt: new Date().toISOString(),
    });
    await this.persist(next);
    this.records = next;
  }

  async remove(id: string): Promise<void> {
    const key = normalizePluginId(id);
    const next = new Map(this.records);
    if (!next.delete(key)) {
      throw pluginNotFound(id);
    }
    await this.persist(next);
    this.records = next;
  }

  async checkUpdates(): Promise<readonly PluginUpdateStatus[]> {
    const records = [...this.records.values()].filter(
      (record) => record.source === "github" && record.github !== undefined,
    );
    const results = await Promise.all(
      records.map(async (record) => {
        try {
          return await checkGithubUpdate(record);
        } catch {
          return undefined;
        }
      }),
    );
    return results
      .filter((result): result is PluginUpdateStatus => result !== undefined)
      .toSorted((a, b) => a.id.localeCompare(b.id));
  }

  async reload(): Promise<ReloadSummary> {
    const prevIds = new Set(this.records.keys());
    const file = await readInstalled(this.kimiHomeDir);
    const next = new Map<string, PluginRecord>();
    const errors: Array<{ id: string; message: string }> = [];
    for (const entry of file.plugins) {
      try {
        next.set(entry.id, await this.materialize(entry));
      } catch (error) {
        errors.push({ id: entry.id, message: (error as Error).message });
      }
    }
    const added: string[] = [];
    for (const id of next.keys()) if (!prevIds.has(id)) added.push(id);
    const removed: string[] = [];
    for (const id of prevIds) if (!next.has(id)) removed.push(id);
    this.records = next;
    return { added, removed, errors };
  }

  enabledHooks(): readonly HookDef[] {
    const out: HookDef[] = [];
    for (const record of this.records.values()) {
      if (
        !record.enabled ||
        record.state !== "ok" ||
        record.manifest === undefined
      )
        continue;
      for (const hook of record.manifest.hooks ?? []) {
        out.push({
          ...hook,
          cwd: record.root,
          env: {
            KIMI_CODE_HOME: this.kimiHomeDir,
            KIMI_PLUGIN_ROOT: record.root,
          },
        });
      }
    }
    return out;
  }

  async enabledCommands(): Promise<readonly PluginCommandDef[]> {
    const out: PluginCommandDef[] = [];
    const records = [...this.records.values()];
    for (const record of records) {
      if (
        !record.enabled ||
        record.state !== "ok" ||
        record.manifest === undefined
      )
        continue;
      for (const entry of record.manifest.commands ?? []) {
        const def = await loadPluginCommand({
          commandPath: entry.path,
          pluginId: record.id,
          fallbackName: entry.name,
        });
        if (def !== undefined) out.push(def);
      }
    }
    return out;
  }

  pluginSkillRoots(): readonly SkillRoot[] {
    const roots: SkillRoot[] = [];
    for (const record of this.records.values()) {
      if (
        !record.enabled ||
        record.state !== "ok" ||
        record.manifest === undefined
      )
        continue;
      for (const dir of record.manifest.skills ?? []) {
        roots.push({
          path: dir,
          source: "extra",
          plugin: { id: record.id, instructions: record.skillInstructions },
        });
      }
    }
    return roots;
  }

  pluginAgentRoots(): readonly PluginAgentRoot[] {
    const roots: PluginAgentRoot[] = [];
    for (const record of this.records.values()) {
      if (
        !record.enabled ||
        record.state !== "ok" ||
        record.manifest === undefined
      )
        continue;
      for (const dir of record.manifest.agents ?? []) {
        roots.push({ path: dir, source: "plugin" });
      }
    }
    return roots;
  }

  enabledSessionStarts(): readonly EnabledPluginSessionStart[] {
    const out: EnabledPluginSessionStart[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== "ok") continue;
      const skill = record.manifest?.sessionStart?.skill;
      if (skill === undefined) continue;
      out.push({ pluginId: record.id, skillName: skill });
    }
    return out;
  }

  enabledSystemPrompts(): readonly EnabledPluginSystemPrompt[] {
    const out: EnabledPluginSystemPrompt[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== "ok") continue;
      const content = record.manifest?.systemPrompt;
      if (content === undefined) continue;
      out.push({ pluginId: record.id, content });
    }
    return out;
  }

  enabledMcpServers(): Record<string, McpServerConfig> {
    const out: Record<string, McpServerConfig> = {};
    for (const record of this.records.values()) {
      if (
        !record.enabled ||
        record.state !== "ok" ||
        record.manifest === undefined
      )
        continue;
      for (const [name, config] of Object.entries(
        record.manifest.mcpServers ?? {},
      )) {
        if (!isMcpServerEnabled(record, name, config)) continue;
        out[pluginMcpRuntimeName(record.id, name)] = withPluginMcpRuntime(
          withMcpServerEnabled(config, true),
          record.root,
          this.kimiHomeDir,
        );
      }
    }
    return out;
  }

  summaries(): readonly PluginSummary[] {
    return this.list().map((record) => recordToSummary(record));
  }

  info(id: string): PluginInfo | undefined {
    const record = this.get(id);
    return record === undefined ? undefined : recordToInfo(record);
  }

  private async persist(
    records: ReadonlyMap<string, PluginRecord>,
  ): Promise<void> {
    const installed: InstalledRecord[] = [...records.values()].map(
      (record) => ({
        id: record.id,
        root: record.root,
        source: record.source,
        enabled: record.enabled,
        installedAt: record.installedAt,
        updatedAt: record.updatedAt,
        originalSource: record.originalSource,
        capabilities: record.capabilities,
        github: record.github,
      }),
    );
    await writeInstalled(this.kimiHomeDir, { version: 1, plugins: installed });
  }

  private async materialize(entry: InstalledRecord): Promise<PluginRecord> {
    const parsed = await parseManifest(entry.root);
    return recordFrom({
      id: entry.id,
      root: entry.root,
      enabled: entry.enabled,
      installedAt: entry.installedAt,
      updatedAt: entry.updatedAt,
      originalSource: entry.originalSource,
      capabilities: entry.capabilities,
      github: entry.github,
      source: entry.source,
      parsed,
      discoverSkills: this.discoverSkills,
    });
  }
}
