/**
 * `workspaceFs` domain — `IWorkspaceFsService` implementation.
 *
 * Implements the fs operations (search / grep / git status / git diff) by
 * orchestrating the os `IHostFileSystem` (file IO, resolved against the
 * workspace root), the handler-shared `ISessionProcessRunner` (`rg`), and
 * `IWorkspaceGitService` (git status/diff bound to the handler root; this
 * service only confines paths and computes repo-relative paths before
 * calling it).
 *
 * Path confinement applies a lexical within-workspace check first (the
 * handler root plus the `workspaceDirs` additional-dir set), then
 * re-verifies the candidate through `IHostFileSystem.realpath` (resolving
 * the longest existing prefix, so not-yet-created paths still work): a
 * symlink inside the workspace must not steer fs actions to files outside
 * it. The small
 * caches (`rgResolution`, `realRootsCache`) are plain per-handler fields.
 * Bound at Workspace scope — one instance per handler, shared by every
 * session of the workspace.
 */

import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  type FsDiffRequest,
  type FsDiffResponse,
  type FsEntry,
  type FsGitStatusRequest,
  type FsGitStatusResponse,
  type FsGrepFileHit,
  type FsGrepMatch,
  type FsGrepRequest,
  type FsGrepResponse,
  type FsListManyRequest,
  type FsListManyResponse,
  type FsListRequest,
  type FsListResponse,
  type FsMkdirRequest,
  type FsMkdirResponse,
  type FsReadRequest,
  type FsReadResponse,
  type FsSearchHit,
  type FsSearchRequest,
  type FsSearchResponse,
  type FsStatManyRequest,
  type FsStatManyResponse,
  type FsStatRequest,
  type FsStatResponse,
} from "./fs";

import ignore, { type Ignore } from "ignore";

import {
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from "#/_base/di/scope";
import {
  buildEtag,
  countLines,
  detectBinary,
  FS_BINARY_SAMPLE_BYTES,
  guessLanguageId,
  guessMime,
} from "#/_base/utils/fileMeta";
import { ErrorCodes, Error2, isError2, unwrapErrorCause } from "#/errors";
import { ITelemetryService } from "#/app/telemetry/telemetry";
import {
  IHostFileSystem,
  type HostDirEntry,
  type HostFileStat,
} from "#/os/interface/hostFileSystem";
import { ISessionProcessRunner } from "#/session/process/processRunner";
import { IWorkspaceContext } from "#/workspace/workspaceContext/workspaceContext";
import { IWorkspaceDirs } from "#/workspace/workspaceDirs/workspaceDirs";
import { IWorkspaceGitService } from "#/workspace/workspaceGit/workspaceGit";

import {
  type FsDownloadResolved,
  type FsPathResolved,
  IWorkspaceFsService,
} from "./fs";
import { readStream, runCommand } from "./internal/fsProcess";
import {
  ensureRgPath,
  type RgProbe,
  type RgResolution,
} from "./internal/rgLocator";
import {
  compileGrepPattern,
  computeFuzzyScore,
  computeMatchPositions,
  matchesAnyGlob,
  type RgJsonRecord,
  rgPath,
  rgText,
  stripTrailingNewline,
} from "./internal/fsSearch";

import {
  RgJsonAccumulator,
  buildFsEntry,
  isHidden,
  isInsideOrEqual,
  isMissingPathError,
  isPrematureCloseError,
  mapFsError,
  sortChildren,
} from "./fsService.support";

const SEARCH_HARD_CAP = 500;
const GREP_TIMEOUT_MS = 30_000;
const WALK_MAX_DEPTH = 64;

const FS_READ_MAX_BYTES = 10 * 1024 * 1024;

import { WorkspaceFsServiceCore } from "./fsService.core";

export class WorkspaceFsService extends WorkspaceFsServiceCore {
  async grep(req: FsGrepRequest): Promise<FsGrepResponse> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GREP_TIMEOUT_MS);
    timer.unref?.();
    try {
      const resolution = await this.resolveRg();
      if (resolution !== null) {
        return await this.grepWithRg(
          req,
          controller.signal,
          startedAt,
          resolution.path,
        );
      }
      this.telemetry.track2("fs_grep_node_fallback", { reason: "rg_missing" });
      return await this.grepWithNode(req, controller.signal, startedAt);
    } finally {
      clearTimeout(timer);
    }
  }

  async gitStatus(req: FsGitStatusRequest): Promise<FsGitStatusResponse> {
    let filter: Set<string> | undefined;
    if (req.paths !== undefined && req.paths.length > 0) {
      filter = new Set();
      for (const p of req.paths) {
        filter.add(this.toRel(await this.resolveWithin(p)));
      }
    }

    return this.git.status(filter);
  }

  async diff(req: FsDiffRequest): Promise<FsDiffResponse> {
    const abs = await this.resolveWithin(req.path);
    return this.git.diff(this.toRel(abs), abs);
  }

  private async grepWithRg(
    req: FsGrepRequest,
    signal: AbortSignal,
    startedAt: number,
    rgPath: string,
  ): Promise<FsGrepResponse> {
    const args = ["--json"];
    if (req.context_lines > 0) {
      args.push("--context", String(req.context_lines));
    }
    if (!req.case_sensitive) args.push("--ignore-case");
    if (!req.regex) args.push("--fixed-strings");
    if (req.follow_gitignore) {
      args.push("--no-require-git");
    } else {
      args.push("--no-ignore");
    }
    if (req.include_globs) {
      for (const g of req.include_globs) args.push("--glob", g);
    }
    if (req.exclude_globs) {
      for (const g of req.exclude_globs) args.push("--glob", `!${g}`);
    }
    args.push("--max-count", String(req.max_matches_per_file));
    args.push(req.pattern);
    args.push(".");

    const proc = await this.runner.exec([rgPath, ...args], {
      cwd: this.workDir,
    });

    const acc = new RgJsonAccumulator(req);
    let killed = false;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      void proc.kill("SIGKILL");
    };
    const onAbort = (): void => kill();
    if (signal.aborted) kill();
    else signal.addEventListener("abort", onAbort, { once: true });

    let stdoutBuf = "";
    const drainStdout = async (): Promise<void> => {
      proc.stdout.setEncoding("utf-8");
      try {
        for await (const chunk of proc.stdout) {
          stdoutBuf += chunk as string;
          let nl = stdoutBuf.indexOf("\n");
          while (nl >= 0) {
            const line = stdoutBuf.slice(0, nl);
            stdoutBuf = stdoutBuf.slice(nl + 1);
            if (line.length > 0) {
              acc.feed(line);
              if (acc.capped) kill();
            }
            nl = stdoutBuf.indexOf("\n");
          }
        }
        if (stdoutBuf.length > 0) acc.feed(stdoutBuf);
      } catch (error) {
        if (!(killed && isPrematureCloseError(error))) throw error;
      }
    };

    try {
      await Promise.all([
        drainStdout(),
        readStream(proc.stderr),
        proc.wait().catch(() => -1),
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort);
      try {
        void proc.dispose();
      } catch {}
    }

    return acc.finish(signal.aborted, Date.now() - startedAt);
  }

  private async grepWithNode(
    req: FsGrepRequest,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<FsGrepResponse> {
    const matcher = req.follow_gitignore ? await this.matcher() : undefined;
    const re = compileGrepPattern(req);

    const files: FsGrepFileHit[] = [];
    let filesScanned = 0;
    let totalMatches = 0;
    let truncated = false;

    const filePaths: string[] = [];
    await this.walk("", matcher, async (rel, _name, kind) => {
      if (kind !== "file") return;
      if (req.include_globs && !matchesAnyGlob(rel, req.include_globs)) return;
      if (req.exclude_globs && matchesAnyGlob(rel, req.exclude_globs)) return;
      filePaths.push(rel);
    });

    for (const rel of filePaths) {
      if (signal.aborted) {
        if (totalMatches === 0 && filesScanned === 0) {
          throw new Error2(
            ErrorCodes.FS_GREP_TIMEOUT,
            `grep timed out after ${Date.now() - startedAt}ms`,
          );
        }
        truncated = true;
        break;
      }
      if (filesScanned >= req.max_files) {
        truncated = true;
        break;
      }
      filesScanned += 1;
      let content: string;
      try {
        content = await this.hostFs.readText(this.absOf(rel));
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      const matches: FsGrepMatch[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        re.lastIndex = 0;
        const m = re.exec(line);
        if (m === null) continue;
        if (matches.length >= req.max_matches_per_file) break;
        const before: string[] = [];
        for (let k = Math.max(0, i - req.context_lines); k < i; k++) {
          before.push(lines[k] ?? "");
        }
        const after: string[] = [];
        for (
          let k = i + 1;
          k < Math.min(lines.length, i + 1 + req.context_lines);
          k++
        ) {
          after.push(lines[k] ?? "");
        }
        matches.push({
          line: i + 1,
          col: m.index + 1,
          text: line,
          before,
          after,
        });
        totalMatches += 1;
        if (totalMatches >= req.max_total_matches) {
          truncated = true;
          break;
        }
      }
      if (matches.length > 0) {
        files.push({ path: rel, matches });
      }
      if (totalMatches >= req.max_total_matches) break;
    }

    return {
      files,
      files_scanned: filesScanned,
      truncated,
      elapsed_ms: Date.now() - startedAt,
    };
  }

  private async walk(
    rootRel: string,
    matcher: Ignore | undefined,
    visit: (
      relPath: string,
      name: string,
      kind: "file" | "directory" | "symlink",
    ) => Promise<void>,
    depth = 0,
  ): Promise<void> {
    if (depth > WALK_MAX_DEPTH) return;
    let entries: readonly HostDirEntry[];
    try {
      entries = await this.hostFs.readdir(this.absOf(rootRel));
    } catch {
      return;
    }
    for (const entry of entries) {
      const { name } = entry;
      if (name === ".git") continue;
      const childRel = rootRel === "" ? name : `${rootRel}/${name}`;
      const isDir = entry.isDirectory && entry.isSymbolicLink !== true;
      if (matcher) {
        const probe = isDir ? `${childRel}/` : childRel;
        if (matcher.ignores(probe)) continue;
      }
      const kind: "file" | "directory" | "symlink" = entry.isSymbolicLink
        ? "symlink"
        : isDir
          ? "directory"
          : "file";
      await visit(childRel, name, kind);
      if (isDir) {
        await this.walk(childRel, matcher, visit, depth + 1);
      }
    }
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceFsService,
  WorkspaceFsService,
  ScopeActivation.OnScopeCreated,
  "workspaceFs",
);
