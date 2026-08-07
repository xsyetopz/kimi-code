/**
 * `media` domain — image decode/encode ladder for model ingestion.
 */

import { normalizeImageMime } from "./image-format-policy";
import { decodeWebp } from "./webp-decode";

export interface ImageCompressionTelemetryClient {
  track(
    event: string,
    properties?: Readonly<
      Record<string, string | number | boolean | null | undefined>
    >,
  ): void;
}

export interface ImageCompressionTelemetry {
  readonly client: ImageCompressionTelemetryClient;
  readonly source: string;
}

type CompressOutcome =
  | "compressed"
  | "passthrough_fast"
  | "passthrough_guard"
  | "passthrough_unsupported"
  | "passthrough_unhelpful"
  | "passthrough_error";

const JPEG_QUALITY_STEPS = [80, 60, 40, 20] as const;

export const FALLBACK_EDGES_PX = [2000, 1000, 768, 512, 384, 256] as const;

const PNG_RESCALE_FLOOR_PX = 1000;

export const MAX_DECODE_PIXELS = 100_000_000;

export const MAX_IMAGE_DECODE_BYTES = 64 * 1024 * 1024;

export const RECODABLE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);


type JimpImage = Awaited<
  ReturnType<typeof import("jimp")["Jimp"]["fromBuffer"]>
>;

interface EncodedImage {
  readonly data: Buffer;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
}

interface EncodeOptions {
  readonly preferLossless: boolean;
  readonly byteBudget: number;
  readonly fallbackEdges: readonly number[];
}

export async function decodeToJimp(
  bytes: Uint8Array,
  normalizedMime: string,
): Promise<JimpImage> {
  const { Jimp } = await import("jimp");
  if (normalizedMime === "image/webp") {
    const decoded = await decodeWebp(bytes);
    return Jimp.fromBitmap({
      data: Buffer.from(
        decoded.data.buffer,
        decoded.data.byteOffset,
        decoded.data.byteLength,
      ),
      width: decoded.width,
      height: decoded.height,
    });
  }
  return Jimp.fromBuffer(Buffer.from(bytes));
}

export async function encodeWithinBudget(
  image: JimpImage,
  opts: EncodeOptions,
): Promise<EncodedImage> {
  const { preferLossless, byteBudget, fallbackEdges } = opts;
  let smallest: EncodedImage | null = null;

  const consider = (data: Buffer, mimeType: string): EncodedImage => {
    const candidate: EncodedImage = {
      data,
      mimeType,
      width: image.width,
      height: image.height,
    };
    if (smallest === null || candidate.data.length < smallest.data.length) {
      smallest = candidate;
    }
    return candidate;
  };

  const jpegLadder = async (): Promise<EncodedImage | null> => {
    for (const quality of JPEG_QUALITY_STEPS) {
      const jpeg = await image.getBuffer("image/jpeg", { quality });
      if (jpeg.length <= byteBudget) return consider(jpeg, "image/jpeg");
      consider(jpeg, "image/jpeg");
    }
    return null;
  };

  if (preferLossless) {
    const png = await image.getBuffer("image/png", { deflateLevel: 9 });
    if (png.length <= byteBudget) return consider(png, "image/png");
    consider(png, "image/png");

    for (const edge of fallbackEdges) {
      if (edge < PNG_RESCALE_FLOOR_PX) break;
      if (!fitWithinEdge(image, edge)) continue;
      const smallerPng = await image.getBuffer("image/png", {
        deflateLevel: 9,
      });
      if (smallerPng.length <= byteBudget)
        return consider(smallerPng, "image/png");
      consider(smallerPng, "image/png");
    }

    const atFloor = await jpegLadder();
    if (atFloor !== null) return atFloor;
    for (const edge of fallbackEdges) {
      if (edge >= PNG_RESCALE_FLOOR_PX) continue;
      if (!fitWithinEdge(image, edge)) continue;
      const atEdge = await jpegLadder();
      if (atEdge !== null) return atEdge;
    }
    return smallest!;
  }

  const atFitted = await jpegLadder();
  if (atFitted !== null) return atFitted;
  for (const edge of fallbackEdges) {
    if (!fitWithinEdge(image, edge)) continue;
    const atEdge = await jpegLadder();
    if (atEdge !== null) return atEdge;
  }

  return smallest!;
}

export function fitWithinEdge(image: JimpImage, edge: number): boolean {
  const longest = Math.max(image.width, image.height);
  if (longest <= edge) return false;
  const factor = edge / longest;
  image.resize({
    w: Math.max(1, Math.round(image.width * factor)),
    h: Math.max(1, Math.round(image.height * factor)),
  });
  return true;
}

interface CropTelemetryResult {
  readonly resized: boolean;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly region: { readonly width: number; readonly height: number };
  readonly finalByteLength: number;
}

type CropErrorKind =
  | "empty"
  | "unsupported_format"
  | "region_invalid"
  | "too_large"
  | "out_of_bounds"
  | "budget"
  | "decode_failed";

interface CompressEventResult {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

export function reportCompressEvent(
  telemetry: ImageCompressionTelemetry | undefined,
  input: {
    readonly outcome: CompressOutcome;
    readonly startedAt: number;
    readonly inputMime: string;
    readonly exifTransposed: boolean;
    readonly result: CompressEventResult;
  },
): void {
  if (telemetry === undefined) return;
  try {
    telemetry.client.track("image_compress", {
      source: telemetry.source,
      outcome: input.outcome,
      input_mime: input.inputMime,
      output_mime: normalizeImageMime(input.result.mimeType),
      original_bytes: input.result.originalByteLength,
      final_bytes: input.result.finalByteLength,
      original_width: input.result.originalWidth,
      original_height: input.result.originalHeight,
      final_width: input.result.width,
      final_height: input.result.height,
      exif_transposed: input.exifTransposed,
      duration_ms: Date.now() - input.startedAt,
    });
  } catch {}
}

export function reportCropEvent(
  telemetry: ImageCompressionTelemetry | undefined,
  input: {
    readonly startedAt: number;
    readonly ok: boolean;
    readonly errorKind?: CropErrorKind;
    readonly result?: CropTelemetryResult;
  },
): void {
  if (telemetry === undefined) return;
  try {
    const { result } = input;
    const originalPixels =
      result === undefined ? 0 : result.originalWidth * result.originalHeight;
    telemetry.client.track("image_crop", {
      source: telemetry.source,
      ok: input.ok,
      error_kind: input.errorKind,
      resized: result?.resized,
      original_width: result?.originalWidth,
      original_height: result?.originalHeight,
      region_area_ratio:
        result === undefined || originalPixels === 0
          ? undefined
          : (result.region.width * result.region.height) / originalPixels,
      final_bytes: result?.finalByteLength,
      duration_ms: Date.now() - input.startedAt,
    });
  } catch {}
}
