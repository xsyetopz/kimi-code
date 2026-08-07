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

export class WorkspaceFsServiceCore implements IWorkspaceFsService {
  declare readonly _serviceBrand: undefined;

  private readonly gitignoreCache = new Map<string, Ignore>();
  private rgResolution: RgResolution | null | undefined = undefined;
  private realRootsCache:
    | { readonly key: string; readonly roots: readonly string[] }
    | undefined = undefined;
  private readonly workDir: string;

  constructor(
    @IWorkspaceContext workspace: IWorkspaceContext,
    @IWorkspaceDirs private readonly workspaceDirs: IWorkspaceDirs,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @ISessionProcessRunner private readonly runner: ISessionProcessRunner,    @IWorkspaceGitService private readonly git: IWorkspaceGitService,
  ) {
    this.workDir = resolve(workspace.cwd);
  }

  private resolvePathInput(rel: string): string {
    return isAbsolute(rel) ? resolve(rel) : resolve(this.workDir, rel);
  }

  private isWithinWorkspace(absPath: string): boolean {
    const target = resolve(absPath);
    if (target === this.workDir) return true;
    const rel = relative(this.workDir, target);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return true;
    return this.workspaceDirs.additionalDirs.some((dir) => {
      const r = relative(resolve(dir), target);
      return r === "" || (!r.startsWith("..") && !isAbsolute(r));
    });
  }

  private absOf(rel: string): string {
    return rel === "" || rel === "." ? this.workDir : join(this.workDir, rel);
  }

  async list(req: FsListRequest): Promise<FsListResponse> {
    const abs = await this.resolveWithin(req.path);
    const rel = this.toRel(abs);

    let topStat: HostFileStat;
    try {
      topStat = await this.hostFs.stat(abs);
    } catch (err) {
      throw mapFsError(err, req.path);
    }
    if (!topStat.isDirectory) {
      throw new Error2(
        ErrorCodes.FS_PATH_NOT_FOUND,
        `path not found: ${req.path}`,
        {
          details: { path: req.path },
        },
      );
    }

    const gitignore = req.follow_gitignore ? await this.matcher() : undefined;

    const items: FsEntry[] = [];
    const childrenByPath: Record<string, FsEntry[]> = {};
    let truncated = false;

    interface QueueEntry {
      readonly relPath: string;
      readonly depthRemaining: number;
    }
    const queue: QueueEntry[] = [
      { relPath: rel === "." ? "" : rel, depthRemaining: req.depth },
    ];

    interface Child {
      readonly name: string;
      readonly relPath: string;
      readonly stat: HostFileStat;
    }

    while (queue.length > 0) {
      const entry = queue.shift()!;
      let names: readonly string[];
      try {
        names = (await this.hostFs.readdir(this.absOf(entry.relPath))).map(
          (e) => e.name,
        );
      } catch (err) {
        if (entry.relPath === (rel === "." ? "" : rel)) {
          throw mapFsError(err, req.path);
        }
        continue;
      }

      const visible: Child[] = [];
      for (const name of names) {
        if (!req.show_hidden && isHidden(name)) continue;
        const childRel =
          entry.relPath === "" ? name : `${entry.relPath}/${name}`;
        if (
          gitignore &&
          (gitignore.ignores(childRel) || gitignore.ignores(`${childRel}/`))
        ) {
          continue;
        }
        if (req.exclude_globs && matchesAnyGlob(childRel, req.exclude_globs))
          continue;
        const st = await this.hostFs
          .lstat(this.absOf(childRel))
          .catch(() => undefined);
        if (st === undefined) continue;
        visible.push({ name, relPath: childRel, stat: st });
      }

      sortChildren(visible, req.sort);

      const parentKey = entry.relPath === "" ? "." : entry.relPath;
      const bucket: FsEntry[] = [];
      for (const child of visible) {
        if (items.length >= req.limit && entry.depthRemaining === req.depth) {
          truncated = true;
          break;
        }
        const fsEntry = buildFsEntry(
          child.relPath,
          child.name,
          child.stat,
          false,
        );
        if (entry.depthRemaining === req.depth) {
          items.push(fsEntry);
        }
        bucket.push(fsEntry);
        if (child.stat.isDirectory && entry.depthRemaining > 1) {
          queue.push({
            relPath: child.relPath,
            depthRemaining: entry.depthRemaining - 1,
          });
        }
      }

      if (entry.depthRemaining < req.depth) {
        childrenByPath[parentKey] = bucket;
      }
    }

    const response: FsListResponse = { items, truncated };
    if (Object.keys(childrenByPath).length > 0) {
      response.children_by_path = childrenByPath;
    }
    return response;
  }

  async read(req: FsReadRequest): Promise<FsReadResponse> {
    const abs = await this.resolveWithin(req.path);
    const rel = this.toRel(abs);

    let st: HostFileStat;
    try {
      st = await this.hostFs.stat(abs);
    } catch (err) {
      throw mapFsError(err, req.path);
    }
    if (st.isDirectory) {
      throw new Error2(
        ErrorCodes.FS_IS_DIRECTORY,
        `path is a directory: ${req.path}`,
        {
          details: { path: req.path },
        },
      );
    }
    if (st.size > FS_READ_MAX_BYTES) {
      throw new Error2(
        ErrorCodes.FS_TOO_LARGE,
        `file too large: ${req.path} (${st.size} bytes > ${FS_READ_MAX_BYTES})`,
        { details: { path: req.path, size: st.size } },
      );
    }

    const sampleSize = Math.min(FS_BINARY_SAMPLE_BYTES, st.size);
    const sample =
      sampleSize === 0
        ? new Uint8Array()
        : await this.hostFs.readBytes(abs, sampleSize);
    const isBinary = detectBinary(sample);

    if (isBinary && req.encoding === "utf-8") {
      throw new Error2(ErrorCodes.FS_IS_BINARY, `file is binary: ${req.path}`, {
        details: { path: req.path },
      });
    }

    const effectiveLength = Math.min(req.length, st.size - req.offset);
    let bytes: Uint8Array;
    if (effectiveLength <= 0) {
      bytes = new Uint8Array();
    } else {
      const window = await this.hostFs.readBytes(
        abs,
        req.offset + effectiveLength,
      );
      bytes = window.subarray(req.offset, req.offset + effectiveLength);
    }

    const encoding: "utf-8" | "base64" =
      req.encoding === "base64" || (req.encoding === "auto" && isBinary)
        ? "base64"
        : "utf-8";
    const content =
      encoding === "utf-8"
        ? Buffer.from(bytes).toString("utf-8")
        : Buffer.from(bytes).toString("base64");
    const truncated = req.offset + effectiveLength < st.size;

    const out: FsReadResponse = {
      path: rel,
      content,
      encoding,
      size: st.size,
      truncated,
      etag: buildEtag(st),
      mime: guessMime(rel, isBinary),
      is_binary: isBinary,
    };
    const languageId = encoding === "utf-8" ? guessLanguageId(rel) : undefined;
    if (languageId !== undefined) out.language_id = languageId;
    if (encoding === "utf-8") out.line_count = countLines(content);
    return out;
  }

  async listMany(req: FsListManyRequest): Promise<FsListManyResponse> {
    const results: Record<string, FsEntry[]> = {};
    const partialErrors: Record<string, { code: number; msg: string }> = {};
    const truncatedPaths: string[] = [];

    await Promise.all(
      req.paths.map(async (p) => {
        try {
          const sub = await this.list({
            path: p,
            depth: req.depth,
            limit: req.limit,
            show_hidden: req.show_hidden,
            follow_gitignore: req.follow_gitignore,
            exclude_globs: req.exclude_globs,
            sort: req.sort,
            include_git_status: req.include_git_status,
          });
          results[p] = sub.items;
          if (sub.truncated) truncatedPaths.push(p);
        } catch (err) {
          if (err instanceof Error2 && err.code === ErrorCodes.FS_PATH_ESCAPES)
            throw err;
          partialErrors[p] = toWireError(err);
        }
      }),
    );

    const out: FsListManyResponse = { results };
    if (truncatedPaths.length > 0) out.truncated_paths = truncatedPaths;
    if (Object.keys(partialErrors).length > 0)
      out.partial_errors = partialErrors;
    return out;
  }

  async stat(req: FsStatRequest): Promise<FsStatResponse> {
    const abs = await this.resolveWithin(req.path);
    const rel = this.toRel(abs);
    let st: HostFileStat;
    try {
      st = await this.hostFs.lstat(abs);
    } catch (err) {
      throw mapFsError(err, req.path);
    }
    const name = rel === "." ? basename(this.workDir) : basename(abs);
    return buildFsEntry(rel, name, st, true);
  }

  async statMany(req: FsStatManyRequest): Promise<FsStatManyResponse> {
    const resolved = await Promise.all(
      req.paths.map(async (p) => {
        const abs = await this.resolveWithin(p);
        return { raw: p, rel: this.toRel(abs), abs };
      }),
    );

    const entries: Record<string, FsEntry | null> = {};
    await Promise.all(
      resolved.map(async ({ raw, rel, abs }) => {
        try {
          const st = await this.hostFs.lstat(abs);
          const name = rel === "." ? basename(this.workDir) : basename(abs);
          entries[raw] = buildFsEntry(rel, name, st, false);
        } catch {
          entries[raw] = null;
        }
      }),
    );
    return { entries };
  }

  async mkdir(req: FsMkdirRequest): Promise<FsMkdirResponse> {
    const abs = await this.resolveWithin(req.path);
    const rel = this.toRel(abs);
    try {
      await this.hostFs.mkdir(abs, { recursive: req.recursive });
    } catch (err) {
      const code = errnoCode(err);
      if (code === "EEXIST") {
        throw new Error2(
          ErrorCodes.FS_ALREADY_EXISTS,
          `path already exists: ${req.path}`,
          {
            details: { path: req.path },
          },
        );
      }
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new Error2(
          ErrorCodes.FS_PATH_NOT_FOUND,
          `parent not found: ${req.path}`,
          {
            details: { path: req.path },
          },
        );
      }
      throw err;
    }
    const st = await this.hostFs.lstat(abs);
    return buildFsEntry(rel, basename(abs), st, false);
  }

  async resolvePath(relPath: string): Promise<FsPathResolved> {
    const abs = await this.resolveWithin(relPath);
    const rel = this.toRel(abs);
    let st: HostFileStat;
    try {
      st = await this.hostFs.lstat(abs);
    } catch (err) {
      throw mapFsError(err, relPath);
    }
    return { absolute: abs, relative: rel, isDirectory: st.isDirectory };
  }

  async resolveDownload(relPath: string): Promise<FsDownloadResolved> {
    const abs = await this.resolveWithin(relPath);
    const rel = this.toRel(abs);
    let st: HostFileStat;
    try {
      st = await this.hostFs.stat(abs);
    } catch (err) {
      throw mapFsError(err, relPath);
    }
    if (st.isDirectory) {
      throw new Error2(
        ErrorCodes.FS_IS_DIRECTORY,
        `path is a directory: ${relPath}`,
        {
          details: { path: relPath },
        },
      );
    }
    const sampleSize = Math.min(FS_BINARY_SAMPLE_BYTES, st.size);
    const sample =
      sampleSize === 0
        ? new Uint8Array()
        : await this.hostFs.readBytes(abs, sampleSize);
    const isBinary = detectBinary(sample);
    return {
      absolute: abs,
      relative: rel,
      size: st.size,
      etag: buildEtag(st),
      mime: guessMime(rel, isBinary),
      modifiedAt: new Date(st.mtimeMs ?? 0),
    };
  }

  async search(req: FsSearchRequest): Promise<FsSearchResponse> {
    if (req.query === "") {
      const listed = await this.list({
        path: ".",
        depth: 1,
        limit: req.limit,
        show_hidden: false,
        follow_gitignore: req.follow_gitignore,
        exclude_globs: req.exclude_globs,
        sort: "type_first",
        include_git_status: false,
      });
      const items = listed.items
        .filter(
          (entry) =>
            req.include_globs === undefined ||
            matchesAnyGlob(entry.path, req.include_globs),
        )
        .map((entry) => ({
          path: entry.path,
          name: entry.name,
          kind: entry.kind,
          score: 1,
          match_positions: [],
        }));
      return { items, truncated: listed.truncated };
    }

    const matcher = req.follow_gitignore ? await this.matcher() : undefined;
    const candidates: FsSearchHit[] = [];
    const queryLower = req.query.toLowerCase();

    await this.walk("", matcher, async (relPath, name, kind) => {
      const score = computeFuzzyScore(name, queryLower);
      if (score <= 0) return;
      if (req.include_globs && !matchesAnyGlob(relPath, req.include_globs)) {
        return;
      }
      if (req.exclude_globs && matchesAnyGlob(relPath, req.exclude_globs)) {
        return;
      }
      candidates.push({
        path: relPath,
        name,
        kind,
        score,
        match_positions: computeMatchPositions(relPath, queryLower),
      });
    });

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.path.localeCompare(b.path);
    });

    const effectiveCap = Math.min(req.limit, SEARCH_HARD_CAP);
    const truncated = candidates.length > effectiveCap;
    return { items: candidates.slice(0, effectiveCap), truncated };
  }

  private async matcher(): Promise<Ignore | undefined> {
    const cwd = this.workDir;
    const cached = this.gitignoreCache.get(cwd);
    if (cached !== undefined) return cached;
    const ig = ignore();
    ig.add(".git/");
    try {
      const contents = await this.hostFs.readText(
        join(this.workDir, ".gitignore"),
      );
      ig.add(contents);
    } catch {}
    this.gitignoreCache.set(cwd, ig);
    return ig;
  }

  private async resolveRg(): Promise<RgResolution | null> {
    if (this.rgResolution !== undefined) return this.rgResolution;
    const probe: RgProbe = {
      exec: (args) => runCommand(this.runner, args, { cwd: this.workDir }),
    };
    try {
      this.rgResolution = await ensureRgPath(probe);
    } catch {
      this.rgResolution = null;
    }
    return this.rgResolution;
  }

  private async realRoots(): Promise<readonly string[]> {
    const dirs = [
      this.workDir,
      ...this.workspaceDirs.additionalDirs.map((d) => resolve(d)),
    ];
    const key = dirs.join("\n");
    if (this.realRootsCache?.key === key) return this.realRootsCache.roots;
    const roots: string[] = [];
    for (const dir of dirs) {
      try {
        roots.push(await this.hostFs.realpath(dir));
      } catch {
        roots.push(dir);
      }
    }
    this.realRootsCache = { key, roots };
    return roots;
  }

  private async realpathExistingPrefix(abs: string): Promise<string> {
    const tail: string[] = [];
    let current = abs;
    for (let i = 0; i < 256; i++) {
      try {
        const real = await this.hostFs.realpath(current);
        return tail.length === 0 ? real : join(real, ...tail.reverse());
      } catch (err) {
        if (!isMissingPathError(err)) throw err;
        const parent = dirname(current);
        if (parent === current) return abs;
        tail.push(basename(current));
        current = parent;
      }
    }
    return abs;
  }

  private async resolveWithin(inputPath: string): Promise<string> {
    if (inputPath === "" || inputPath === "/") {
      throw new Error2(
        ErrorCodes.FS_PATH_ESCAPES,
        `path "${inputPath}" rejected (empty)`,
        {
          details: { path: inputPath, reason: "empty" },
        },
      );
    }
    if (isAbsolute(inputPath)) {
      throw new Error2(
        ErrorCodes.FS_PATH_ESCAPES,
        `path "${inputPath}" rejected (absolute)`,
        {
          details: { path: inputPath, reason: "absolute" },
        },
      );
    }
    const segments = inputPath.split(/[/\\]+/);
    if (segments.some((s) => s === "..")) {
      throw new Error2(
        ErrorCodes.FS_PATH_ESCAPES,
        `path "${inputPath}" rejected (dotdot segment)`,
        {
          details: { path: inputPath, reason: "dotdot_segment" },
        },
      );
    }
    const abs = this.resolvePathInput(inputPath);
    if (!this.isWithinWorkspace(abs)) {
      throw new Error2(
        ErrorCodes.FS_PATH_ESCAPES,
        `path "${inputPath}" escapes workspace`,
        {
          details: { path: inputPath, reason: "resolved_outside" },
        },
      );
    }
    const resolved = await this.realpathExistingPrefix(abs);
    const roots = await this.realRoots();
    if (!roots.some((root) => isInsideOrEqual(resolved, root))) {
      throw new Error2(
        ErrorCodes.FS_PATH_ESCAPES,
        `path "${inputPath}" escapes workspace through a symlink`,
        { details: { path: inputPath, reason: "symlink_outside" } },
      );
    }
    return abs;
  }

  private toRel(abs: string): string {
    const cwd = this.workDir;
    if (abs === cwd) return ".";
    const rel = relative(cwd, abs);
    if (rel === "") return ".";
    return rel.split(sep).join("/");
  }
}
