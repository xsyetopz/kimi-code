/** A pre-gzipped self-contained SPA HTML page, served from memory. */
export interface WebAsset {
  /** gzip-compressed bytes of the single-file index.html. */
  readonly gzipped: Uint8Array;
}

/** Serve the embedded SPA for any non-/api GET (SPA fallback: same page for
 *  every client route, since the bundle is a single self-contained HTML). */
export function serveWebAsset(asset: WebAsset): Response {
  // Node's Uint8Array uses ArrayBufferLike while the DOM `BodyInit` typing
  // currently requires a concrete ArrayBuffer. The runtime accepts both.
  return new Response(asset.gzipped as unknown as BodyInit, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-encoding": "gzip",
      "cache-control": "no-store",
    },
  });
}
