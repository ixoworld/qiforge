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
 * `value` without what can disguise text: Unicode controls (Cc), format
 * characters (Cf: bidi overrides such as U+202E, zero-width joiners), line
 * and paragraph separators (Zl, Zp), and `[` / `]` (they would forge a
 * `[source: …]` note).
 */
function visibleText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}[\]]/gu, '');
}

/**
 * Clean a client-supplied filename before it reaches LLM context, a log
 * line, a room event or an archive path (the archive writes under this exact
 * name): `visibleText`, then only the last path segment is kept (`/` and
 * `\` both separate) and any remaining `..` becomes `_`, cut to 255 UTF-16
 * units without splitting a surrogate pair.
 */
export function sanitizeAttachmentFilename(filename: string): string {
  const visible = visibleText(filename);
  const basename = visible.slice(
    Math.max(visible.lastIndexOf('/'), visible.lastIndexOf('\\')) + 1,
  );
  return cutUnits(basename.replace(/\.\.+/g, '_'), 255);
}

/** Longest filename / mimetype / event id / mxc URI written into a hidden note. */
export const NOTE_FILENAME_MAX = 255;
export const NOTE_MIMETYPE_MAX = 100;
export const NOTE_EVENT_ID_MAX = 255;
export const NOTE_URI_MAX = 512;

/**
 * Clean a client-supplied value (filename, mimetype, media event id, mxc
 * URI) for the hidden notes the model reads: `visibleText` (no path
 * handling: a mimetype or a URI keeps its slashes) plus quotes removed
 * (the notes wrap names and refs in `"…"`), cut to `max` UTF-16 units
 * without splitting a surrogate pair.
 */
export function sanitizeNoteField(value: string, max: number): string {
  return cutUnits(visibleText(value).replace(/"/g, ''), max);
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
