/**
 * Downscale an image before the model sees it, through the optional
 * Cloudflare Images binding (`IMAGES`, docs/configuration.md). A native image
 * block is the file's base64 and is replayed on every later turn, so a 4 MB
 * phone photo costs ~5.3 MB of request per call; at a 1568 px long edge as
 * JPEG it is a few hundred KB and reads the same to a vision model.
 *
 * Only the copy handed to the model changes: callers archive the original
 * bytes. Without the binding, for a type the binding does not take (SVG,
 * BMP, TIFF, HEIC, …), for an image already within the bound, and on any
 * binding error, the input is returned unchanged, so an oracle that does not
 * bind Images behaves as before.
 *
 * The bound is on the LONG edge: `maxWidth` caps both width and height, so a
 * tall phone screenshot is reduced too. The dimensions are read first with
 * `info()` (not billed); only an image with either side over the bound is
 * transformed (one unique transformation, billed after the monthly free
 * allowance). `fit: 'scale-down'` keeps the aspect ratio and never upscales.
 */
import type { Logger } from '../plugin-api/types';

/** Longest edge handed to a model (px): Anthropic's recommended maximum edge. */
export const RESIZE_MAX_EDGE = 1568;
/** JPEG quality of a downscaled image. */
export const RESIZE_JPEG_QUALITY = 82;

/**
 * Raster types the binding decodes. A GIF is flattened to its first frame by
 * the JPEG output.
 */
const RESIZABLE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/** Fill under transparent pixels: JPEG has no alpha channel. */
const JPEG_BACKGROUND = '#ffffff';

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes).body ?? new ReadableStream<Uint8Array>();
}

export async function resizeForModel(
  bytes: Uint8Array,
  mimetype: string,
  images: ImagesBinding | undefined,
  opts: { maxWidth?: number; quality?: number; logger?: Logger } = {},
): Promise<{ bytes: Uint8Array; mimetype: string }> {
  const original = { bytes, mimetype };
  if (!images) return original;
  const type = mimetype.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!RESIZABLE_TYPES.has(type)) return original;
  // `maxWidth` (the caller's name) bounds both sides.
  const maxEdge = opts.maxWidth ?? RESIZE_MAX_EDGE;
  try {
    const info = await images.info(streamOf(bytes));
    // An SVG reports no dimensions; it is never rasterised here.
    if (!('width' in info) || (info.width <= maxEdge && info.height <= maxEdge))
      return original;
    const result = await images
      .input(streamOf(bytes))
      .transform({ width: maxEdge, height: maxEdge, fit: 'scale-down' })
      .output({
        format: 'image/jpeg',
        quality: opts.quality ?? RESIZE_JPEG_QUALITY,
        background: JPEG_BACKGROUND,
      });
    const resized = new Uint8Array(await result.response().arrayBuffer());
    if (resized.length === 0) throw new Error('empty output');
    opts.logger?.log(
      `[attachments] image ${info.width}×${info.height}px resized to fit ${maxEdge}px (${bytes.length} → ${resized.length} bytes)`,
    );
    return { bytes: resized, mimetype: result.contentType() };
  } catch (error) {
    opts.logger?.warn(
      `[attachments] image resize failed (${type}, ${bytes.length} bytes), sending the original: ${error instanceof Error ? error.message : String(error)}`,
    );
    return original;
  }
}
