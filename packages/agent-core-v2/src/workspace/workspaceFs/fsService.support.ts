/**
 * `workspaceFs` domain — grep accumulator and fs entry helpers.
 */

import { isAbsolute, relative } from "node:path";

import type {
  FsGrepRequest,
  FsGrepResponse,
  FsGrepMatch,
  FsGrepFileHit,
  FsListRequest,
  FsEntry,
} from "./fs";
import { isAbsolute, relative } from "node:path";
import { ErrorCodes, Error2, isError2, unwrapErrorCause } from "#/errors";
import type { HostFileStat } from "#/os/interface/hostFileSystem";
import { buildEtag, guessLanguageId, guessMime } from "#/_base/utils/fileMeta";
import {
  stripTrailingNewline,
  rgPath,
  rgText,
  type RgJsonRecord,
} from "./internal/fsSearch";

export const FsWireErrorCode = {
  FS_PATH_NOT_FOUND: 40409,
  FS_IS_DIRECTORY: 40906,
  FS_IS_BINARY: 40907,
  FS_TOO_LARGE: 41302,
  FS_TOO_MANY_RESULTS: 41303,
  INTERNAL_ERROR: 50001,
} as const;

const HIDDEN_NAME_RE = /^\./;
const MACOS_NOISE = new Set([".DS_Store", ".AppleDouble", ".LSOverride"]);

export class RgJsonAccumulator {
  private readonly fileBuf = new Map<
    string,
    { matches: FsGrepMatch[]; pending: string[]; lastMatchLine: number }
  >();
  private readonly files: FsGrepFileHit[] = [];
  private totalMatches = 0;
  private filesScanned = 0;
  private truncated = false;

  constructor(private readonly req: FsGrepRequest) {}

  get capped(): boolean {
    return (
      this.totalMatches >= this.req.max_total_matches ||
      this.filesScanned >= this.req.max_files
    );
  }

  feed(line: string): void {
    let rec: RgJsonRecord;
    try {
      rec = JSON.parse(line) as RgJsonRecord;
    } catch {
      return;
    }
    const t = rec.type;
    if (t === "begin") {
      const p = rgPath(rec.data?.path);
      if (p === undefined) return;
      if (this.filesScanned >= this.req.max_files) {
        this.truncated = true;
        return;
      }
      this.fileBuf.set(p, { matches: [], pending: [], lastMatchLine: -1 });
      this.filesScanned += 1;
    } else if (t === "context") {
      const p = rgPath(rec.data?.path);
      if (p === undefined) return;
      const buf = this.fileBuf.get(p);
      if (buf === undefined) return;
      buf.pending.push(stripTrailingNewline(rgText(rec.data?.lines)));
      if (buf.pending.length > this.req.context_lines * 2) {
        buf.pending.shift();
      }
    } else if (t === "match") {
      const p = rgPath(rec.data?.path);
      if (p === undefined) return;
      const buf = this.fileBuf.get(p);
      if (buf === undefined) return;
      if (this.totalMatches >= this.req.max_total_matches) {
        this.truncated = true;
        return;
      }
      if (buf.matches.length >= this.req.max_matches_per_file) return;
      const text = stripTrailingNewline(rgText(rec.data?.lines));
      const lineNo = rec.data?.line_number ?? 0;
      const col = (rec.data?.submatches?.[0]?.start ?? 0) + 1;
      const before = buf.pending.slice(-this.req.context_lines);
      buf.pending.length = 0;
      buf.matches.push({ line: lineNo, col, text, before, after: [] });
      buf.lastMatchLine = lineNo;
      this.totalMatches += 1;
      if (this.totalMatches >= this.req.max_total_matches)
        this.truncated = true;
    } else if (t === "end") {
      const p = rgPath(rec.data?.path);
      if (p === undefined) return;
      this.finalize(p);
    }
  }

  finish(aborted: boolean, elapsedMs: number): FsGrepResponse {
    for (const p of this.fileBuf.keys()) {
      this.finalize(p);
    }
    let truncated = this.truncated;
    if (aborted) {
      if (this.totalMatches === 0 && this.filesScanned === 0) {
        throw new Error2(
          ErrorCodes.FS_GREP_TIMEOUT,
          `grep timed out after ${elapsedMs}ms`,
        );
      }
      truncated = true;
    }
    return {
      files: this.files,
      files_scanned: this.filesScanned,
      truncated,
      elapsed_ms: elapsedMs,
    };
  }

  private finalize(p: string): void {
    const buf = this.fileBuf.get(p);
    if (buf === undefined) return;
    if (buf.matches.length > 0 && buf.pending.length > 0) {
      const last = buf.matches[buf.matches.length - 1]!;
      last.after = buf.pending.slice(0, this.req.context_lines);
    }
    if (buf.matches.length > 0) {
      this.files.push({ path: p, matches: buf.matches });
    }
    this.fileBuf.delete(p);
  }
}

export function isHidden(name: string): boolean {
  return HIDDEN_NAME_RE.test(name) || MACOS_NOISE.has(name);
}

export function isPrematureCloseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE"
  );
}

export function sortChildren(
  children: { name: string; stat: HostFileStat }[],
  sort: FsListRequest["sort"],
): void {
  const cmp = {
    type_first: (
      a: { name: string; stat: HostFileStat },
      b: { name: string; stat: HostFileStat },
    ) => {
      const ad = a.stat.isDirectory ? 0 : 1;
      const bd = b.stat.isDirectory ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    },
    name_asc: (a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name),
    name_desc: (a: { name: string }, b: { name: string }) =>
      b.name.localeCompare(a.name),
    mtime_desc: (a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name),
    size_desc: (a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name),
  }[sort];
  children.sort(cmp);
}

export function buildFsEntry(
  relPath: string,
  name: string,
  st: HostFileStat,
  withMime: boolean,
): FsEntry {
  const kind: FsEntry["kind"] = st.isSymbolicLink
    ? "symlink"
    : st.isDirectory
      ? "directory"
      : "file";
  const entry: FsEntry = {
    path: relPath,
    name,
    kind,
    modified_at: new Date(st.mtimeMs ?? 0).toISOString(),
    etag: buildEtag(st),
  };
  if (kind === "file") {
    entry.size = st.size;
  }
  if (withMime && kind === "file") {
    entry.mime = guessMime(relPath, false);
    const lang = guessLanguageId(relPath);
    if (lang !== undefined) entry.language_id = lang;
  }
  return entry;
}

export function errnoCode(err: unknown): string | undefined {
  const unwrapped = unwrapErrorCause(err);
  if (
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    "code" in unwrapped
  ) {
    const c = (unwrapped as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

export function isMissingPathError(err: unknown): boolean {
  if (isError2(err)) {
    return (
      err.code === ErrorCodes.OS_FS_NOT_FOUND ||
      err.code === ErrorCodes.OS_FS_NOT_DIRECTORY
    );
  }
  const code = errnoCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

export function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

export function mapFsError(err: unknown, inputPath: string): Error {
  const code = errnoCode(err);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new Error2(
      ErrorCodes.FS_PATH_NOT_FOUND,
      `path not found: ${inputPath}`,
      {
        details: { path: inputPath },
      },
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

export function toWireError(err: unknown): { code: number; msg: string } {
  if (err instanceof Error2) {
    switch (err.code) {
      case ErrorCodes.FS_PATH_NOT_FOUND:
        return { code: FsWireErrorCode.FS_PATH_NOT_FOUND, msg: err.message };
      case ErrorCodes.FS_IS_DIRECTORY:
        return { code: FsWireErrorCode.FS_IS_DIRECTORY, msg: err.message };
      case ErrorCodes.FS_IS_BINARY:
        return { code: FsWireErrorCode.FS_IS_BINARY, msg: err.message };
      case ErrorCodes.FS_TOO_LARGE:
        return { code: FsWireErrorCode.FS_TOO_LARGE, msg: err.message };
      case ErrorCodes.FS_TOO_MANY_RESULTS:
        return { code: FsWireErrorCode.FS_TOO_MANY_RESULTS, msg: err.message };
    }
  }
  return {
    code: FsWireErrorCode.INTERNAL_ERROR,
    msg: err instanceof Error ? err.message : "internal error",
  };
}
