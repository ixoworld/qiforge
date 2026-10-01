/**
 * Fallback when the homeserver's media config endpoint is unavailable.
 * Matches the Synapse deployment cap (`max_upload_size: 100M`).
 */
export const DEFAULT_MEDIA_UPLOAD_SIZE_LIMIT = 100 * 1024 * 1024;

/**
 * Extract `m.upload.size` from a `GET /_matrix/client/v1/media/config`
 * (or legacy `/_matrix/media/v3/config`) response body.
 */
export function parseUploadSizeLimit(response: unknown): number | undefined {
  if (typeof response !== 'object' || response === null) {
    return undefined;
  }
  if (!('m.upload.size' in response)) {
    return undefined;
  }
  const size: unknown = response['m.upload.size'];
  if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
    return size;
  }
  return undefined;
}
