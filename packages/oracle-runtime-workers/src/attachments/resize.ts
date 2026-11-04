/**
 * Downscale an image before the model sees it, through the optional
 * Cloudflare Images binding (`IMAGES`, docs/configuration.md). A native image
 * block is the file's base64 and is replayed on every later turn, so a 4 MB
 * phone photo costs ~5.3 MB of request per call; at a 1568 px long edge as
 * JPEG it is a few hundred KB and reads the same to a vision model.
 *
 * Only the copy handed to the model changes: callers archive the original
 * bytes. Without the binding, for a type the binding does not take (SVG,
 * BMP, TIFF, HEIC, …), for an image already within the bound, and when
 * `info()` fails for another reason than a malformed image (its dimensions
 * are then unknown), the input is returned unchanged, so an oracle that does
 * not bind Images behaves as before.
 *
 * An image that must not go to the model as it is comes back with
 * `dropped`, a short reason, and the caller does not send it natively: one
 * the binding reports as malformed (not an image, an unsupported format, a
 * file it cannot decode), one over `RESIZE_HARD_MAX_PIXELS` /
 * `RESIZE_HARD_MAX_SIDE` (never transformed), and one over the bound whose
 * transformation fails or yields nothing. `bytes`/`mimetype` are then the
 * input's, for the caller's log.
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
 * Largest image area transformed (pixels). Cloudflare refuses images over
 * 100 megapixels (error 9413); half of that leaves no photo out and keeps a
 * decompression bomb from being sent on.
 */
export const RESIZE_HARD_MAX_PIXELS = 50_000_000;
/** Longest side transformed (px); a longer one is dropped. */
export const RESIZE_HARD_MAX_SIDE = 12_000;

/**
 * Cloudflare Images error codes that mean the input itself is unusable:
 * 9412 not an image, 9520 an unsupported format, 9523 an image it could
 * not decode (developers.cloudflare.com/images/reference/troubleshooting).
 */
const MALFORMED_IMAGE_ERROR = /\b(9412|9520|9523)\b/;

export interface ResizedImage {
  bytes: Uint8Array;
  mimetype: string;
  /**
   * Set when the image must not be sent to the model natively: why, in a
   * few words (for logs and the model-facing note).
   */
  dropped?: string;
}

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
): Promise<ResizedImage> {
  const original = { bytes, mimetype };
  if (!images) return original;
  const type = mimetype.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!RESIZABLE_TYPES.has(type)) return original;
  // `maxWidth` (the caller's name) bounds both sides.
  const maxEdge = opts.maxWidth ?? RESIZE_MAX_EDGE;
  const drop = (reason: string): ResizedImage => {
    opts.logger?.warn(
      `[attachments] image not sent to the model (${type}, ${bytes.length} bytes): ${reason}`,
    );
    return { ...original, dropped: reason };
  };
  let info: Awaited<ReturnType<ImagesBinding['info']>>;
  try {
    info = await images.info(streamOf(bytes));
  } catch (error) {
    const message = errorMessage(error);
    if (MALFORMED_IMAGE_ERROR.test(message))
      return drop(`not a readable image (${message})`);
    opts.logger?.warn(
      `[attachments] image info failed (${type}, ${bytes.length} bytes), sending the original: ${message}`,
    );
    return original;
  }
  // An SVG reports no dimensions; it is never rasterised here.
  if (!('width' in info) || (info.width <= maxEdge && info.height <= maxEdge))
    return original;
  if (
    info.width > RESIZE_HARD_MAX_SIDE ||
    info.height > RESIZE_HARD_MAX_SIDE ||
    info.width * info.height > RESIZE_HARD_MAX_PIXELS
  )
    return drop(`${info.width}×${info.height}px is over the size limit`);
  try {
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
    return drop(
      `${info.width}×${info.height}px could not be resized (${errorMessage(error)})`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
