/**
 * `media` domain — image compression captions and byte-size formatting.
 */

export interface ImageVariantDescription {
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly mimeType: string;
}

export interface ImageCompressionCaptionInput {
  readonly original: ImageVariantDescription;
  readonly final: ImageVariantDescription;
  readonly originalPath?: string | null;
}

export function buildImageCompressionCaption(
  input: ImageCompressionCaptionInput,
): string {
  const sentences = [
    `Image compressed to fit model limits: original ${describeImageVariant(input.original)} -> ` +
      `sent ${describeImageVariant(input.final)}.`,
    "Fine detail may be lost.",
  ];
  if (typeof input.originalPath === "string" && input.originalPath.length > 0) {
    sentences.push(
      `The uncompressed original is saved at "${input.originalPath}"; if you need fine detail ` +
        "(e.g. small text), call ReadMediaFile on that path with the region parameter " +
        "(original-pixel coordinates) to view a crop at full fidelity.",
    );
  } else {
    sentences.push("The uncompressed original was not preserved.");
  }
  return `<system>${sentences.join(" ")}</system>`;
}

const CAPTION_OPENING = "<system>Image compressed to fit model limits:";

const CAPTION_PATTERN =
  /<system>(Image compressed to fit model limits:[\s\S]*?)<\/system>/g;

export interface ImageCompressionCaptionExtraction {
  readonly captions: readonly string[];
  readonly text: string;
}

export function extractImageCompressionCaptions(
  text: string,
): ImageCompressionCaptionExtraction {
  if (!text.includes(CAPTION_OPENING)) return { captions: [], text };
  const captions: string[] = [];
  const remainder = text.replace(CAPTION_PATTERN, (_match, body: string) => {
    captions.push(body);
    return "";
  });
  return { captions, text: remainder };
}

function describeImageVariant(variant: ImageVariantDescription): string {
  const size = `${variant.mimeType} (${formatByteSize(variant.byteLength)})`;
  if (variant.width > 0 && variant.height > 0) {
    return `${String(variant.width)}x${String(variant.height)} ${size}`;
  }
  return size;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
