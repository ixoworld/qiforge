/**
 * Filename / sandbox-path hygiene — the Node runtime's `attachment-archive.ts`
 * plus `FileProcessingService.sanitizeSandboxPath`.
 */

/** Where every attachment a user sends is archived in their sandbox. */
export const SANDBOX_OUTPUT_PREFIX = '/workspace/output';

/**
 * `value` in at most `max` UTF-16 units, cut before a surrogate pair rather
 * than through it (a multi-byte filename never ends in half a character).
 */
function cutUnits(value: string, max: number): string {
  if (value.length <= max) return value;
  const end = /[\ud800-\udbff]/.test(value[max - 1] ?? '') ? max - 1 : max;
  return value.slice(0, end);
}

/**
 * Strip control characters and bracket sequences from a filename to prevent
 * prompt injection when interpolated into LLM context. The archive writes
 * under this exact name.
 */
export function sanitizeAttachmentFilename(filename: string): string {
  return cutUnits(
    filename
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/[[\]]/g, ''),
    255,
  );
}

/** Longest filename / mimetype / event id / mxc URI written into a hidden note. */
export const NOTE_FILENAME_MAX = 255;
export const NOTE_MIMETYPE_MAX = 100;
export const NOTE_EVENT_ID_MAX = 255;
export const NOTE_URI_MAX = 512;

/**
 * Clean a client-supplied value (filename, mimetype, media event id, mxc
 * URI) for the hidden notes the model reads: the filename cleaner plus
 * quotes removed (the notes wrap names and refs in `"…"`), cut to `max`
 * UTF-16 units without splitting a surrogate pair.
 */
export function sanitizeNoteField(value: string, max: number): string {
  return cutUnits(sanitizeAttachmentFilename(value).replace(/"/g, ''), max);
}

/**
 * Sanitize a filename/path for the sandbox upload endpoint: only
 * alphanumerics, dots, dashes, underscores and slashes, and no `..` segments
 * so the sandbox cannot be escaped.
 */
export function sanitizeSandboxPath(p: string): string {
  const charset = p.replace(/[^a-zA-Z0-9._\-/]/g, '_');
  return charset
    .split('/')
    .filter((seg) => seg !== '..')
    .join('/');
}
