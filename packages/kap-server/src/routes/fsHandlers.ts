import { createReadStream } from "node:fs";

import {
  ErrorCodes,
  IWorkspaceFsService,
  IWorkspaceLifecycleService,
  IWorkspaceService,
  getLiveSessionById,
  resumeSessionById,
  isError2,
  Error2,
  type Scope,
} from "@moonshot-ai/agent-core-v2";
import {
  fsDiffRequestSchema,
  fsGitStatusRequestSchema,
  fsGrepRequestSchema,
  fsListManyRequestSchema,
  fsListRequestSchema,
  fsMkdirRequestSchema,
  fsReadRequestSchema,
  fsSearchRequestSchema,
  fsStatManyRequestSchema,
  fsStatRequestSchema,
} from "@moonshot-ai/agent-core-v2/workspace/workspaceFs/fs";

import { errEnvelope, okEnvelope } from "../envelope";
import {
  launchDetached,
  openFileCommandFor,
  openInAppCommandFor,
  revealFileCommandFor,
} from "../lib/fileLaunch";
import { requestLog } from "../lib/requestLog";
import { ErrorCode } from "../protocol/error-codes";
import {
  fsOpenInRequestSchema,
  fsOpenRequestSchema,
  fsRevealRequestSchema,
} from "../protocol/rest-fs";

export function resolveFs(core: Scope, sessionId: string): IWorkspaceFsService {
  const session = getLiveSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(
      ErrorCodes.SESSION_NOT_FOUND,
      `session ${sessionId} does not exist`,
    );
  }
  return session.accessor.get(IWorkspaceFsService);
}

type Req = { id: string; body: unknown };
type Reply = { send(payload: unknown): unknown };

export async function handleList(
  core: Scope,
  sessionId: string,
  req: Req,
  reply: Reply,
): Promise<void> {
  const parsed = fsListRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).list(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

export async function handleRead(
  core: Scope,
  sessionId: string,
  req: Req,
  reply: Reply,
): Promise<void> {
  const parsed = fsReadRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).read(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

export async function handleListMany(
  core: Scope,
  sessionId: string,
  req: Req,
  reply: Reply,
): Promise<void> {
  const parsed = fsListManyRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).listMany(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

export async function handleStat(
  core: Scope,
  sessionId: string,
  req: Req,
  reply: Reply,
): Promise<void> {
  const parsed = fsStatRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).stat(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

export async function handleStatMany(
  core: Scope,
  sessionId: string,
  req: Req,
  reply: Reply,
): Promise<void> {
  const parsed = fsStatManyRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).statMany(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

export async function handleMkdir(
  core: Scope,
  sessionId: string,
  req: Req,
  reply: Reply,
): Promise<void> {
  const parsed = fsMkdirRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).mkdir(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

export async function handleSearch(
  fs: IWorkspaceFsService,
  req: Req,
  reply: Reply,
): Promise<void> {
  const parsed = fsSearchRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.search(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

export async function handleGrep(
  core: Scope,
  sessionId: string,
  req: Req,
  reply: Reply,
): Promise<void> {
  const parsed = fsGrepRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).grep(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

export async function handleGitStatus(
  core: Scope,
  sessionId: string,
  req: Req,
  reply: Reply,
): Promise<void> {
  const parsed = fsGitStatusRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).gitStatus(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

export async function handleDiff(
  core: Scope,
  sessionId: string,
  req: Req,
  reply: Reply,
): Promise<void> {
  const parsed = fsDiffRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).diff(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

export async function handleOpen(
  core: Scope,
  sessionId: string,
  req: Req,
  reply: Reply,
): Promise<void> {
  const parsed = fsOpenRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const resolved = await resolveFs(core, sessionId).resolvePath(
    parsed.data.path,
  );
  await launchDetached(openFileCommandFor(resolved.absolute, parsed.data.line));
  reply.send(okEnvelope({ opened: true as const }, req.id));
}

export async function handleReveal(
  core: Scope,
  sessionId: string,
  req: Req,
  reply: Reply,
): Promise<void> {
  const parsed = fsRevealRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const resolved = await resolveFs(core, sessionId).resolvePath(
    parsed.data.path,
  );
  await launchDetached(revealFileCommandFor(resolved.absolute));
  reply.send(okEnvelope({ revealed: true as const }, req.id));
}

export async function handleOpenIn(
  core: Scope,
  sessionId: string,
  req: Req,
  reply: Reply,
): Promise<void> {
  const parsed = fsOpenInRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const body = parsed.data;
  const resolved = await resolveFs(core, sessionId).resolvePath(body.path);
  try {
    await launchDetached(
      openInAppCommandFor(body.app_id, resolved.absolute, {
        line: body.line,
        isDirectory: resolved.isDirectory,
      }),
    );
  } catch (err) {
    requestLog(req)?.warn(
      { session_id: sessionId, app_id: body.app_id, err },
      "fs open-in launch failed",
    );
    reply.send(
      errEnvelope(
        ErrorCode.INTERNAL_ERROR,
        `failed to open in ${body.app_id}: ${err instanceof Error ? err.message : String(err)}`,
        req.id,
      ),
    );
    return;
  }
  reply.send(okEnvelope({ opened: true as const }, req.id));
}

// ---------------------------------------------------------------------------
// Error mapping — domain Error2 codes → protocol wire codes.
// ---------------------------------------------------------------------------

export function sendMappedError(
  reply: Reply,
  req: { id: string },
  err: unknown,
): void {
  const requestId = req.id;
  const log = requestLog(req);
  if (isError2(err)) {
    switch (err.code) {
      case ErrorCodes.FS_PATH_ESCAPES:
        reply.send(
          errEnvelope(
            ErrorCode.FS_PATH_ESCAPES_SESSION,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.FS_PATH_NOT_FOUND:
        reply.send(
          errEnvelope(
            ErrorCode.FS_PATH_NOT_FOUND,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.FS_IS_DIRECTORY:
        reply.send(
          errEnvelope(
            ErrorCode.FS_IS_DIRECTORY,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.FS_ALREADY_EXISTS:
        reply.send(
          errEnvelope(
            ErrorCode.FS_ALREADY_EXISTS,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.FS_IS_BINARY:
        reply.send(
          errEnvelope(
            ErrorCode.FS_IS_BINARY,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.FS_TOO_LARGE:
        reply.send(
          errEnvelope(
            ErrorCode.FS_TOO_LARGE,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.FS_TOO_MANY_RESULTS:
        reply.send(
          errEnvelope(
            ErrorCode.FS_TOO_MANY_RESULTS,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.FS_GREP_TIMEOUT:
        reply.send(
          errEnvelope(
            ErrorCode.FS_GREP_TIMEOUT,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.FS_GIT_UNAVAILABLE:
        reply.send(
          errEnvelope(
            ErrorCode.FS_GIT_UNAVAILABLE,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.SESSION_NOT_FOUND:
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      // hostFs errors that escaped the workspaceFs layer keep their `os.fs.*`
      // code; map them onto the closest v1 wire code (ENOTDIR collapses into
      // path-not-found, matching `mapFsError`).
      case ErrorCodes.OS_FS_NOT_FOUND:
      case ErrorCodes.OS_FS_NOT_DIRECTORY:
        reply.send(
          errEnvelope(
            ErrorCode.FS_PATH_NOT_FOUND,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.OS_FS_IS_DIRECTORY:
        reply.send(
          errEnvelope(
            ErrorCode.FS_IS_DIRECTORY,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.OS_FS_ALREADY_EXISTS:
        reply.send(
          errEnvelope(
            ErrorCode.FS_ALREADY_EXISTS,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
      case ErrorCodes.OS_FS_PERMISSION_DENIED:
        reply.send(
          errEnvelope(
            ErrorCode.FS_PERMISSION_DENIED,
            err.message,
            requestId,
            err.stack,
          ),
        );
        return;
    }
  }
  log?.error({ err }, "fs request failed");
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
      requestId,
      err instanceof Error ? err.stack : undefined,
    ),
  );
}

function buildValidationEnvelope(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  requestId: string,
): {
  code: number;
  msg: string;
  data: null;
  request_id: string;
  details: { path: string; message: string }[];
} {
  const details = issues.map((i) => ({
    path: i.path.map((p) => String(p)).join("."),
    message: i.message,
  }));
  const first = details[0];
  const msg =
    first === undefined
      ? "validation failed"
      : first.path === ""
        ? first.message
        : `${first.path}: ${first.message}`;
  return {
    code: ErrorCode.VALIDATION_FAILED,
    msg,
    data: null,
    request_id: requestId,
    details,
  };
}

export function sanitizeFilename(rel: string): string {
  const segs = rel.split("/");
  const base = segs[segs.length - 1] ?? rel;
  return base.replace(/"/g, '\\"');
}
