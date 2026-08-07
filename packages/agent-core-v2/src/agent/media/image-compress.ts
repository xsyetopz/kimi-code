/**
 * `media` domain — image compression for model ingestion.
 *
 * Shrink oversized images before they reach the model.
 *
 * A multimodal request carries each image as a base64 data URL; an unbounded
 * screenshot or photo wastes context tokens and can blow past the provider's
 * per-image byte ceiling. This module downsamples and re-encodes such images
 * so they fit a pixel + byte budget, while leaving already-small images
 * untouched — the common case is a fast, codec-free pass-through.
 *
 * Design notes:
 *  - Pure JS (jimp + a wasm WebP decoder), imported lazily so the codecs are
 *    only paid for when an image actually needs work; startup and the fast
 *    path stay cheap.
 *  - Best effort: any decode/encode failure returns the original bytes
 *    unchanged (`changed: false`). Callers must verify that this unchanged
 *    result satisfies their delivery limits before forwarding it.
 *  - Format gate first: content-part lists pass through
 *    {@link gateImageFormatParts} before any compression, so images outside
 *    the provider-accepted set are never decoded or forwarded — one
 *    unsupported image in the session history would make every subsequent
 *    request fail.
 *  - PNG, JPEG, and (non-animated) WebP are re-encoded; WebP re-encodes
 *    through the PNG/JPEG ladder after a wasm decode. GIF and animated WebP
 *    are passed through to preserve animation. Formats outside the
 *    provider-accepted set never reach this module from the content-part
 *    paths (the format gate drops them first); direct callers get a
 *    passthrough.
 *  - Compression must never be silent to the model: results carry the
 *    original dimensions, {@link buildImageCompressionCaption} renders the
 *    shared "what was compressed, where is the original" note every ingestion
 *    point can place next to the image, and {@link cropImageForModel} lets a
 *    caller read a region of the original back at full fidelity.
 */

import type { ContentPart } from "#/kosong/contract/message";

import {
  buildMalformedImageNotice,
  buildUnsupportedImageNotice,
  decodeBase64Prefix,
  isDataUrl,
  isModelAcceptedImageMime,
  normalizeImageMime,
  parseImageDataUrl,
  resolveEffectiveImageMime,
  unsupportedImageMimeFromUrl,
} from "./image-format-policy";
import { sniffImageDimensions } from "./file-type";
import { isAnimatedWebp } from "./webp-decode";
import {
  decodeToJimp,
  encodeWithinBudget,
  fitWithinEdge,
  FALLBACK_EDGES_PX,
  MAX_DECODE_PIXELS,
  RECODABLE_MIME,
} from "./image-compress-encode";

export type {
  ImageCompressionCaptionExtraction,
  ImageCompressionCaptionInput,
  ImageVariantDescription,
} from "./image-compress-caption";
export {
  buildImageCompressionCaption,
  extractImageCompressionCaptions,
  formatByteSize,
} from "./image-compress-caption";

export const MAX_IMAGE_EDGE_PX = 2000;

let configuredMaxImageEdgePx: number | undefined;

export function setConfiguredMaxImageEdgePx(value: number | undefined): void {
  configuredMaxImageEdgePx =
    value !== undefined && isPositiveInt(value) ? value : undefined;
}

export function resolveMaxImageEdgePx(): number {
  return configuredMaxImageEdgePx ?? MAX_IMAGE_EDGE_PX;
}

export const IMAGE_BYTE_BUDGET = 3.75 * 1024 * 1024;

export const READ_IMAGE_BYTE_BUDGET = 256 * 1024;

let configuredReadImageByteBudget: number | undefined;

export function setConfiguredReadImageByteBudget(
  value: number | undefined,
): void {
  configuredReadImageByteBudget =
    value !== undefined && isPositiveInt(value) ? value : undefined;
}

export function resolveReadImageByteBudget(): number {
  return configuredReadImageByteBudget ?? READ_IMAGE_BYTE_BUDGET;
}

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export { MAX_IMAGE_DECODE_BYTES } from "./image-compress-encode";

export interface CompressImageOptions {
  readonly maxEdge?: number;
  readonly byteBudget?: number;
  readonly maxDecodeBytes?: number;
}

type CompressOutcome =
  | "compressed"
  | "passthrough_fast"
  | "passthrough_guard"
  | "passthrough_unsupported"
  | "passthrough_unhelpful"
  | "passthrough_error";

export interface CompressImageResult {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly changed: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

export async function compressImageForModel(
  bytes: Uint8Array,
  mimeType: string,
  options: CompressImageOptions = {},
): Promise<CompressImageResult> {
  const startedAt = Date.now();
  const maxEdge = options.maxEdge ?? resolveMaxImageEdgePx();
  const byteBudget = options.byteBudget ?? IMAGE_BYTE_BUDGET;
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_IMAGE_DECODE_BYTES;
  const normalizedMime = normalizeImageMime(mimeType);
  const dims = sniffImageDimensions(bytes);

  const passthrough = (): CompressImageResult => ({
    data: bytes,
    mimeType,
    width: dims?.width ?? 0,
    height: dims?.height ?? 0,
    originalWidth: dims?.width ?? 0,
    originalHeight: dims?.height ?? 0,
    changed: false,
    originalByteLength: bytes.length,
    finalByteLength: bytes.length,
  });
  const finish = (
    outcome: CompressOutcome,
    result: CompressImageResult,
  ): CompressImageResult => {
    return result;
  };

  if (bytes.length === 0)
    return finish("passthrough_unsupported", passthrough());
  if (!RECODABLE_MIME.has(normalizedMime))
    return finish("passthrough_unsupported", passthrough());
  if (normalizedMime === "image/webp" && isAnimatedWebp(bytes)) {
    return finish("passthrough_unsupported", passthrough());
  }

  const longestEdge = dims ? Math.max(dims.width, dims.height) : 0;
  const withinBytes = bytes.length <= byteBudget;
  const withinEdge = longestEdge > 0 && longestEdge <= maxEdge;
  if (withinBytes && (withinEdge || longestEdge === 0)) {
    return finish("passthrough_fast", passthrough());
  }

  if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) {
    return finish("passthrough_guard", passthrough());
  }
  if (bytes.length > maxDecodeBytes)
    return finish("passthrough_guard", passthrough());

  try {
    const image = await decodeToJimp(bytes, normalizedMime);
    const preferLossless = normalizedMime !== "image/jpeg";
    const decodedWidth = image.width;
    const decodedHeight = image.height;

    fitWithinEdge(image, maxEdge);

    const encoded = await encodeWithinBudget(image, {
      preferLossless,
      byteBudget,
      fallbackEdges: FALLBACK_EDGES_PX,
    });

    const originalPixels = decodedWidth * decodedHeight;
    const finalPixels = encoded.width * encoded.height;
    const shrankBytes = encoded.data.length < bytes.length;
    const shrankPixels = finalPixels < originalPixels;
    if (!shrankBytes && !shrankPixels)
      return finish("passthrough_unhelpful", passthrough());

    return finish("compressed", {
      data: encoded.data,
      mimeType: encoded.mimeType,
      width: encoded.width,
      height: encoded.height,
      originalWidth: decodedWidth,
      originalHeight: decodedHeight,
      changed: true,
      originalByteLength: bytes.length,
      finalByteLength: encoded.data.length,
    });
  } catch {
    return finish("passthrough_error", passthrough());
  }
}

export interface CompressBase64Result {
  readonly base64: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly changed: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

export async function compressBase64ForModel(
  base64: string,
  mimeType: string,
  options: CompressImageOptions = {},
): Promise<CompressBase64Result> {
  const startedAt = Date.now();
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_IMAGE_DECODE_BYTES;
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > maxDecodeBytes) {
    const result: CompressBase64Result = {
      base64,
      mimeType,
      width: 0,
      height: 0,
      originalWidth: 0,
      originalHeight: 0,
      changed: false,
      originalByteLength: approxBytes,
      finalByteLength: approxBytes,
    };
    return result;
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    const result: CompressBase64Result = {
      base64,
      mimeType,
      width: 0,
      height: 0,
      originalWidth: 0,
      originalHeight: 0,
      changed: false,
      originalByteLength: 0,
      finalByteLength: 0,
    };
    return result;
  }
  const result = await compressImageForModel(bytes, mimeType, options);
  if (!result.changed) {
    return {
      base64,
      mimeType,
      width: result.width,
      height: result.height,
      originalWidth: result.originalWidth,
      originalHeight: result.originalHeight,
      changed: false,
      originalByteLength: result.originalByteLength,
      finalByteLength: result.finalByteLength,
    };
  }
  return {
    base64: Buffer.from(result.data).toString("base64"),
    mimeType: result.mimeType,
    width: result.width,
    height: result.height,
    originalWidth: result.originalWidth,
    originalHeight: result.originalHeight,
    changed: true,
    originalByteLength: result.originalByteLength,
    finalByteLength: result.finalByteLength,
  };
}

export interface CompressedContentParts {
  readonly parts: ContentPart[];
  readonly captions: readonly string[];
}

export function gateImageFormatParts(
  parts: readonly ContentPart[],
): ContentPart[] {
  const out: ContentPart[] = [];
  for (const part of parts) {
    if (part.type === "image_url") {
      const parsed = parseImageDataUrl(part.imageUrl.url);
      if (parsed === null) {
        if (isDataUrl(part.imageUrl.url)) {
          out.push({
            type: "text",
            text: buildMalformedImageNotice(part.imageUrl.url),
          });
          continue;
        }
        const extMime = unsupportedImageMimeFromUrl(part.imageUrl.url);
        if (extMime !== null) {
          out.push({
            type: "text",
            text: buildUnsupportedImageNotice(extMime, part.imageUrl.url),
          });
          continue;
        }
        out.push(part);
        continue;
      }
      const effectiveMime = resolveEffectiveImageMime(
        parsed.mimeType,
        decodeBase64Prefix(parsed.base64),
      );
      if (!isModelAcceptedImageMime(effectiveMime)) {
        out.push({
          type: "text",
          text: buildUnsupportedImageNotice(effectiveMime),
        });
        continue;
      }
      const canonicalUrl = `data:${normalizeImageMime(effectiveMime)};base64,${parsed.base64}`;
      if (part.imageUrl.url !== canonicalUrl) {
        out.push({
          type: "image_url",
          imageUrl: { ...part.imageUrl, url: canonicalUrl },
        });
        continue;
      }
    }
    out.push(part);
  }
  return out;
}

export async function compressImageContentParts(
  parts: readonly ContentPart[],
  options: CompressImageOptions & {
    readonly annotate?: CompressAnnotateOptions;
  } = {},
): Promise<CompressedContentParts> {
  const { annotate, ...compressOptions } = options;
  const out: ContentPart[] = [];
  const captions: string[] = [];
  for (const part of gateImageFormatParts(parts)) {
    if (part.type === "image_url") {
      const parsed = parseImageDataUrl(part.imageUrl.url);
      if (parsed !== null) {
        const result = await compressBase64ForModel(
          parsed.base64,
          parsed.mimeType,
          compressOptions,
        );
        if (result.changed) {
          if (annotate !== undefined) {
            let originalPath: string | null = null;
            if (annotate.persistOriginal !== undefined) {
              try {
                originalPath = await annotate.persistOriginal(
                  Buffer.from(parsed.base64, "base64"),
                  parsed.mimeType,
                );
              } catch {
                originalPath = null;
              }
            }
            captions.push(
              buildImageCompressionCaption({
                original: {
                  width: result.originalWidth,
                  height: result.originalHeight,
                  byteLength: result.originalByteLength,
                  mimeType: parsed.mimeType,
                },
                final: {
                  width: result.width,
                  height: result.height,
                  byteLength: result.finalByteLength,
                  mimeType: result.mimeType,
                },
                originalPath,
              }),
            );
          }
          out.push({
            type: "image_url",
            imageUrl: {
              ...part.imageUrl,
              url: `data:${result.mimeType};base64,${result.base64}`,
            },
          });
          continue;
        }
      }
    }
    out.push(part);
  }
  return { parts: out, captions };
}

export interface CompressAnnotateOptions {
  readonly persistOriginal?: (
    bytes: Uint8Array,
    mimeType: string,
  ) => Promise<string | null>;
}

export interface ImageCropRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CropImageOptions extends CompressImageOptions {
  readonly skipResize?: boolean;
}

export interface CropImageSuccess {
  readonly ok: true;
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly region: ImageCropRegion;
  readonly resized: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

export interface CropImageFailure {
  readonly ok: false;
  readonly error: string;
}

export type CropImageOutcome = CropImageSuccess | CropImageFailure;

export async function cropImageForModel(
  bytes: Uint8Array,
  mimeType: string,
  region: ImageCropRegion,
  options: CropImageOptions = {},
): Promise<CropImageOutcome> {
  const startedAt = Date.now();
  const maxEdge = options.maxEdge ?? resolveMaxImageEdgePx();
  const byteBudget = options.byteBudget ?? IMAGE_BYTE_BUDGET;
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_IMAGE_DECODE_BYTES;
  const normalizedMime = normalizeImageMime(mimeType);

  const fail = (errorKind: CropErrorKind, error: string): CropImageFailure => {
    return { ok: false, error };
  };
  const succeed = (result: CropImageSuccess): CropImageSuccess => {
    return result;
  };

  if (bytes.length === 0) {
    return fail("empty", "The image is empty.");
  }
  if (!RECODABLE_MIME.has(normalizedMime)) {
    return fail(
      "unsupported_format",
      `Cropping is only supported for PNG, JPEG, and WebP images; got ${mimeType}.`,
    );
  }
  if (normalizedMime === "image/webp" && isAnimatedWebp(bytes)) {
    return fail(
      "unsupported_format",
      "Cropping is not supported for animated WebP images.",
    );
  }
  if (
    ![region.x, region.y, region.width, region.height].every((value) =>
      Number.isFinite(value),
    )
  ) {
    return fail(
      "region_invalid",
      `Region coordinates must be finite numbers; got x=${String(region.x)}, ` +
        `y=${String(region.y)}, width=${String(region.width)}, height=${String(region.height)}.`,
    );
  }
  const dims = sniffImageDimensions(bytes);
  if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) {
    return fail(
      "too_large",
      `The image (${String(dims.width)}x${String(dims.height)} pixels) is too large to decode for cropping.`,
    );
  }
  if (bytes.length > maxDecodeBytes) {
    return fail("too_large", "The image is too large to decode for cropping.");
  }

  try {
    const image = await decodeToJimp(bytes, normalizedMime);
    const originalWidth = image.width;
    const originalHeight = image.height;

    const x = Math.floor(region.x);
    const y = Math.floor(region.y);
    if (
      x < 0 ||
      y < 0 ||
      x >= originalWidth ||
      y >= originalHeight ||
      region.width < 1 ||
      region.height < 1
    ) {
      return fail(
        "out_of_bounds",
        `Region (x=${String(region.x)}, y=${String(region.y)}, width=${String(region.width)}, ` +
          `height=${String(region.height)}) lies outside the ${String(originalWidth)}x${String(originalHeight)} image.`,
      );
    }
    const w = Math.min(Math.floor(region.width), originalWidth - x);
    const h = Math.min(Math.floor(region.height), originalHeight - y);
    const applied: ImageCropRegion = { x, y, width: w, height: h };
    image.crop({ x, y, w, h });
    const preferLossless = normalizedMime !== "image/jpeg";

    if (options.skipResize === true) {
      const buffer = preferLossless
        ? await image.getBuffer("image/png", { deflateLevel: 9 })
        : await image.getBuffer("image/jpeg", { quality: 90 });
      if (buffer.length > byteBudget) {
        return fail(
          "budget",
          `The cropped region encodes to ${String(buffer.length)} bytes ` +
            `(${formatByteSize(buffer.length)}), over the ${String(byteBudget)}-byte ` +
            `(${formatByteSize(byteBudget)}) per-image limit. ` +
            "Choose a smaller region, or allow downscaling.",
        );
      }
      return succeed({
        ok: true,
        data: new Uint8Array(buffer),
        mimeType: preferLossless ? "image/png" : "image/jpeg",
        width: image.width,
        height: image.height,
        originalWidth,
        originalHeight,
        region: applied,
        resized: false,
        originalByteLength: bytes.length,
        finalByteLength: buffer.length,
      });
    }

    fitWithinEdge(image, maxEdge);
    const encoded = await encodeWithinBudget(image, {
      preferLossless,
      byteBudget,
      fallbackEdges: FALLBACK_EDGES_PX,
    });
    return succeed({
      ok: true,
      data: new Uint8Array(encoded.data),
      mimeType: encoded.mimeType,
      width: encoded.width,
      height: encoded.height,
      originalWidth,
      originalHeight,
      region: applied,
      resized: encoded.width !== w || encoded.height !== h,
      originalByteLength: bytes.length,
      finalByteLength: encoded.data.length,
    });
  } catch (error) {
    return fail(
      "decode_failed",
      `Failed to decode the image for cropping: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
