/**
 * Filename / sandbox-path hygiene — the Node runtime's `attachment-archive.ts`
 * plus `FileProcessingService.sanitizeSandboxPath`.
 */

/** Where every attachment a user sends is archived in their sandbox. */
export const SANDBOX_OUTPUT_PREFIX = '/workspace/output';

/**
 * Strip control characters and bracket sequences from a filename to prevent
 * prompt injection when interpolated into LLM context. The archive writes
 * under this exact name.
 */
export function sanitizeAttachmentFilename(filename: string): string {
  return (
    filename
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/[[\]]/g, '')
      .slice(0, 255)
  );
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
