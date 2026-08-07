/**
 * Media tool registration.
 *
 * `ReadMediaFile` is only useful when the active model can consume image or
 * video input, so registration is capability-gated here instead of inside the
 * tool (v1 threw a `SkipThisTool` sentinel from the constructor).
 *
 * `createVideoUploader` is a thin binder over a `ModelRequester`'s optional
 * `uploadVideo`. Auth is already resolved via the requester's auth-provider
 * closure; media tooling doesn't need to know about tokens.
 */

import type { ModelCapability } from "#/kosong/contract/capability";
import type { ModelRequester } from "#/kosong/model/modelRequester";

import { toDisposable, type IDisposable } from "#/_base/di/lifecycle";
import type { WorkspaceConfig } from "#/tool/path-access";
import type { IHostFileSystem } from "#/os/interface/hostFileSystem";
import type { IHostEnvironment } from "#/os/interface/hostEnvironment";
import type { IAgentToolRegistryService } from "#/agent/toolRegistry/toolRegistry";
import { ReadMediaFileTool } from "#/agent/tools/read-media-file/readMediaFileTool";
import type { VideoUploader } from "#/agent/tools/read-media-file/read-media-file";

export interface RegisterMediaToolsDeps {
  readonly fs: IHostFileSystem;
  readonly env: IHostEnvironment;
  readonly workspace: WorkspaceConfig;
  readonly capabilities: ModelCapability;
  readonly videoUploader?: VideoUploader;
  readonly inlineVideoSupported?: boolean;
}

export function registerMediaTools(
  toolRegistry: IAgentToolRegistryService,
  deps: RegisterMediaToolsDeps,
): IDisposable {
  if (!deps.capabilities.image_in && !deps.capabilities.video_in) {
    return toDisposable(() => {});
  }
  return toolRegistry.register(
    new ReadMediaFileTool(
      deps.fs,
      deps.env,
      deps.workspace,
      deps.capabilities,
      deps.videoUploader,
      deps.inlineVideoSupported,
    ),
  );
}

export function createVideoUploader(
  requester: Pick<ModelRequester, "uploadVideo"> | undefined,
): VideoUploader | undefined {
  const uploadVideo = requester?.uploadVideo;
  if (uploadVideo === undefined) return undefined;
  const bound = uploadVideo.bind(requester);
  return (input, options) => bound(input, options);
}
