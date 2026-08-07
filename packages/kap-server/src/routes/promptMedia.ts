import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";

import {
  buildImageCompressionCaption,
  buildUnsupportedImageNotice,
  buildKimiFileUrl,
  compressBase64ForModel,
  compressImageForModel,
  decodeBase64Prefix,
  isError2,
  Error2,
  isModelAcceptedImageMime,
  normalizeImageMime,
  persistOriginalImage,
  resolveEffectiveImageMime,
  unsupportedImageMimeFromUrl,
  type GetResult,
  type IFileService,
} from "@moonshot-ai/agent-core-v2";
import type { PromptSubmission } from "../protocol/rest-prompt";

const VIDEO_EXT_BY_MIME: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-msvideo": ".avi",
  "video/x-matroska": ".mkv",
  "video/mpeg": ".mpeg",
};

interface ResolvePromptMediaOptions {
  /**
   * Lazily resolve the session's media-originals dir for persisting the
   * pre-compression bytes of inline base64 images. Only invoked when an image
   * was actually compressed; a failure or undefined result falls back to the
   * shared temp-dir cache.
   */
  readonly resolveOriginalsDir?: () => Promise<string | undefined>;
  /**
   * Lazily resolve the session's attachments dir for materializing arbitrary
   * file uploads (and image bytes the provider rejects) into a path the model
   * can open with the Read tool. A failure or undefined result falls back to
   * the shared cache dir.
   */
  readonly resolveAttachmentsDir?: () => Promise<string | undefined>;
}

export async function resolvePromptMediaFiles(
  body: PromptSubmission,
  store: IFileService,
  cacheDir: string,
  options: ResolvePromptMediaOptions = {},
): Promise<PromptSubmission> {
  let changed = false;
  let originalsDir: string | undefined;
  let originalsDirResolved = false;
  const resolveOriginalsDir = async (): Promise<string | undefined> => {
    if (!originalsDirResolved) {
      originalsDirResolved = true;
      originalsDir = await options
        .resolveOriginalsDir?.()
        .catch(() => undefined);
    }
    return originalsDir;
  };
  let attachmentsDir: string | undefined;
  let attachmentsDirResolved = false;
  const resolveAttachmentsDir = async (): Promise<string> => {
    if (!attachmentsDirResolved) {
      attachmentsDirResolved = true;
      attachmentsDir = await options
        .resolveAttachmentsDir?.()
        .catch(() => undefined);
    }
    return attachmentsDir ?? cacheDir;
  };
  const content: PromptSubmission["content"] = [];
  for (const part of body.content) {
    // Inline base64 image: compress the payload in place. This mirrors the v1
    // server path for REST clients that submit an image without uploading it.
    if (part.type === "image" && part.source.kind === "base64") {
      // Formats the provider cannot accept must never enter the session
      // history — one unsupported image_url makes every later request fail.
      // The bytes are authoritative: an image labeled image/png that is
      // actually AVIF is gated on the sniffed format, not the label. The
      // bytes are still the user's content, though: persist them as a
      // path-referenced attachment so the model can read and convert them
      // itself (best effort — the plain notice stands in when persisting
      // fails). Inline base64 has no original name, so the file is addressed
      // by content hash with a name derived from the sniffed format.
      const effectiveMime = resolveEffectiveImageMime(
        part.source.media_type,
        decodeBase64Prefix(part.source.data),
      );
      if (!isModelAcceptedImageMime(effectiveMime)) {
        const bytes = Buffer.from(part.source.data, "base64");
        const name = `image.${imageExtensionForMime(effectiveMime)}`;
        const persisted = await persistAttachmentBytes(
          bytes,
          `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}-${name}`,
          await resolveAttachmentsDir(),
        );
        content.push({
          type: "text",
          text:
            persisted === null
              ? buildUnsupportedImageNotice(effectiveMime)
              : buildAttachedFileNotice(
                  name,
                  effectiveMime,
                  bytes.length,
                  persisted,
                ),
        });
        changed = true;
        continue;
      }
      const canonicalMime = normalizeImageMime(effectiveMime);
      const compressed = await compressBase64ForModel(
        part.source.data,
        canonicalMime,
        {},
      );
      if (compressed.changed) {
        const dir = await resolveOriginalsDir();
        const originalPath = await persistOriginalImage(
          Buffer.from(part.source.data, "base64"),
          part.source.media_type,
          { dir },
        );
        content.push({
          type: "text",
          text: buildImageCompressionCaption({
            original: {
              width: compressed.originalWidth,
              height: compressed.originalHeight,
              byteLength: compressed.originalByteLength,
              mimeType: part.source.media_type,
            },
            final: {
              width: compressed.width,
              height: compressed.height,
              byteLength: compressed.finalByteLength,
              mimeType: compressed.mimeType,
            },
            originalPath,
          }),
        });
        content.push({
          type: "image",
          source: {
            kind: "base64",
            media_type: compressed.mimeType,
            data: compressed.base64,
          },
        });
        changed = true;
      } else {
        content.push(part);
      }
      continue;
    }

    // Remote image URL: no bytes to sniff, so reject when its path extension
    // names a format providers reject (e.g. a link ending in `.avif`) — the
    // notice keeps the URL so the model can still fetch and convert the
    // image. Extensionless / unknown URLs pass through to the provider and
    // the 400 recovery. Image+URL parts that pass are re-emitted unchanged.
    if (part.type === "image" && part.source.kind === "url") {
      const extMime = unsupportedImageMimeFromUrl(part.source.url);
      if (extMime !== null) {
        content.push({
          type: "text",
          text: buildUnsupportedImageNotice(extMime, part.source.url),
        });
        changed = true;
        continue;
      }
      content.push(part);
      continue;
    }

    // Arbitrary file attachment: materialize the uploaded bytes next to the
    // session and replace the part with a path reference — the model opens it
    // with the Read tool instead of receiving it as a media part.
    if (part.type === "file") {
      const file = await store.get(part.file_id);
      const attachedPath = await materializeAttachmentToDir(
        file,
        await resolveAttachmentsDir(),
      );
      content.push({
        type: "text",
        text: buildAttachedFileNotice(
          file.meta.name,
          file.meta.media_type,
          file.meta.size,
          attachedPath,
        ),
      });
      changed = true;
      continue;
    }

    if (
      (part.type !== "image" && part.type !== "video") ||
      part.source.kind !== "file"
    ) {
      content.push(part);
      continue;
    }

    const file = await store.get(part.source.file_id);
    assertMediaFile(file, part.type);
    if (part.type === "image") {
      const data = await readFileOrStream(file);
      let mediaType = file.meta.media_type;
      let bytes: Uint8Array = data;
      // Same format gate as the inline path above, and again the bytes are
      // authoritative: an upload whose Content-Type lies (AVIF bytes sent
      // as image/png) is gated on the sniffed format. Like the inline path,
      // keep the bytes as a path-referenced attachment instead of dropping
      // them (best effort — the plain notice stands in when persisting
      // fails).
      mediaType = resolveEffectiveImageMime(mediaType, data);
      if (!isModelAcceptedImageMime(mediaType)) {
        const persisted = await persistAttachmentBytes(
          data,
          `${file.meta.id}-${sanitizeAttachmentName(file.meta.name)}`,
          await resolveAttachmentsDir(),
        );
        content.push({
          type: "text",
          text:
            persisted === null
              ? buildUnsupportedImageNotice(mediaType, file.meta.name)
              : buildAttachedFileNotice(
                  file.meta.name,
                  mediaType,
                  file.meta.size,
                  persisted,
                ),
        });
        changed = true;
        continue;
      }
      // Forward the canonical MIME (image/jpg → image/jpeg, case/whitespace)
      // — strict provider whitelists reject the raw alias.
      mediaType = normalizeImageMime(mediaType);
      const compressed = await compressImageForModel(data, mediaType);
      if (compressed.changed) {
        const dir = await resolveOriginalsDir();
        const originalPath = await persistOriginalImage(data, mediaType, {
          dir,
        });
        content.push({
          type: "text",
          text: buildImageCompressionCaption({
            original: {
              width: compressed.originalWidth,
              height: compressed.originalHeight,
              byteLength: compressed.originalByteLength,
              mimeType: mediaType,
            },
            final: {
              width: compressed.width,
              height: compressed.height,
              byteLength: compressed.finalByteLength,
              mimeType: compressed.mimeType,
            },
            originalPath,
          }),
        });
      }
      bytes = compressed.data;
      mediaType = compressed.mimeType;
      content.push({
        type: "image",
        source: {
          kind: "base64",
          media_type: mediaType,
          data: Buffer.from(bytes).toString("base64"),
        },
      });
      changed = true;
      continue;
    }

    // Uploaded video: materialize a local copy the model can open as a
    // fallback, and carry the upload into context as an internal
    // `kimi-file://<id>?path=<materialized path>` reference. The engine
    // resolves it to a provider form (upload / inline / `<video path>` tag) at
    // request time, so the edge never uploads and never blocks on the provider.
    const cachePath = await materializeVideoToCache(file, cacheDir);
    content.push({
      type: "video",
      source: { kind: "url", url: buildKimiFileUrl(file.meta.id, cachePath) },
    });
    changed = true;
  }
  return changed ? { ...body, content } : body;
}

async function materializeVideoToCache(
  file: GetResult,
  cacheDir: string,
): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  const ext =
    extname(file.meta.name) ||
    (VIDEO_EXT_BY_MIME[file.meta.media_type.toLowerCase()] ?? ".bin");
  const target = join(cacheDir, `${file.meta.id}${ext}`);
  const info = await stat(target).catch(() => undefined);
  if (info?.size === file.meta.size) return target;

  await pipeline(file.stream(), createWriteStream(target));
  return target;
}

const ATTACHMENT_NAME_MAX = 100;

/**
 * Attachment file names are untrusted (the multipart filename / a wire field):
 * strip path separators, control chars, and leading dots so the materialized
 * file can never escape its directory or land as a hidden file, and cap the
 * length so the path stays manageable.
 */
function sanitizeAttachmentName(name: string): string {
  const cleaned = name
    .replaceAll(/[\\/]/g, "_")
    .replaceAll(/[\u0000-\u001F\u007F]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, ATTACHMENT_NAME_MAX);
  return cleaned.length > 0 ? cleaned : "attachment";
}

/** Stream an uploaded file into `dir` as `<fileId>-<sanitized name>`. */
async function materializeAttachmentToDir(
  file: GetResult,
  dir: string,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const target = join(
    dir,
    `${file.meta.id}-${sanitizeAttachmentName(file.meta.name)}`,
  );
  const info = await stat(target).catch(() => undefined);
  if (info?.size === file.meta.size) return target;

  await pipeline(file.stream(), createWriteStream(target));
  return target;
}

/**
 * Write already-buffered attachment bytes into `dir` under `name` (the caller
 * builds the name: file-id or content-hash prefixed). Best effort — returns
 * null instead of throwing so a prompt never fails over the persisted copy.
 */
async function persistAttachmentBytes(
  bytes: Uint8Array,
  name: string,
  dir: string,
): Promise<string | null> {
  try {
    await mkdir(dir, { recursive: true });
    const target = join(dir, name);
    const info = await stat(target).catch(() => undefined);
    if (info?.size !== bytes.length) await writeFile(target, bytes);
    return target;
  } catch {
    return null;
  }
}

/** Derive a file extension from an image MIME (`image/svg+xml` → `svg`). */
function imageExtensionForMime(mediaType: string): string {
  const subtype = mediaType.split("/")[1]?.toLowerCase().split("+")[0] ?? "";
  const ext = subtype.replaceAll(/[^a-z0-9-]/g, "");
  return ext.length > 0 ? ext : "img";
}

// This notice's exact shape is a client contract: kimi-web's messagesToTurns
// parses it (ATTACHED_FILE_NOTICE_RE) to rebuild the attachment chip after a
// resync — change the wording there too.
function buildAttachedFileNotice(
  name: string,
  mediaType: string,
  size: number,
  path: string,
): string {
  return `Attached file "${name}" (${mediaType}, ${size} bytes): ${path} — open it with the Read tool`;
}

async function readFileOrStream(file: GetResult): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.stream()) {
    chunks.push(Buffer.from(chunk as string | Uint8Array));
  }
  return Buffer.concat(chunks);
}

function assertMediaFile(file: GetResult, expected: "image" | "video"): void {
  const prefix = expected === "video" ? "video/" : "image/";
  if (file.meta.media_type.toLowerCase().startsWith(prefix)) return;
  throw new Error2(
    "validation.failed",
    `file ${file.meta.id} is ${file.meta.media_type}, not ${expected === "video" ? "a video" : "an image"}`,
  );
}
