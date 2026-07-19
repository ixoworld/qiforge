/**
 * Classify an attachment into a coarse `kind` from its mimetype (primary) and
 * filename extension (fallback for generic mimetypes like
 * `application/octet-stream`). The kind drives routing in `route.ts`.
 *
 * `text` means "plain text we can read ourselves for free" (csv/txt/json/md/…)
 * — deliberately separate from `document` (pdf/office), which is richer and
 * either sent to the model natively or extracted by the helper model.
 */

export type AttachmentKind =
  | 'text'
  | 'document'
  | 'image'
  | 'audio'
  | 'video'
  | 'unknown';

const TEXT_MIMES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/rtf',
  'application/yaml',
  'application/x-yaml',
  'application/csv',
]);
const TEXT_EXTENSIONS = new Set([
  'txt',
  'csv',
  'tsv',
  'json',
  'md',
  'markdown',
  'xml',
  'yaml',
  'yml',
  'log',
  'html',
  'htm',
  'rtf',
]);

const DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
const DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
]);

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'tiff',
  'tif',
  'heic',
  'svg',
]);
const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'wav',
  'ogg',
  'oga',
  'm4a',
  'flac',
  'aac',
]);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v']);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

export function classifyAttachment(input: {
  mimetype: string;
  filename: string;
}): AttachmentKind {
  const mime = input.mimetype.toLowerCase();
  const ext = extensionOf(input.filename);

  // Plain text first — cheap to read locally, and it should win over a generic
  // `application/*` classification (e.g. a `.csv` sent as octet-stream).
  if (
    mime.startsWith('text/') ||
    TEXT_MIMES.has(mime) ||
    TEXT_EXTENSIONS.has(ext)
  ) {
    return 'text';
  }
  if (mime.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (mime.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (mime.startsWith('video/') || VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (DOCUMENT_MIMES.has(mime) || DOCUMENT_EXTENSIONS.has(ext))
    return 'document';
  return 'unknown';
}
