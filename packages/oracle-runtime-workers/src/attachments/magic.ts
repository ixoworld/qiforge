/**
 * Content sniffing + the extraction lane's coarse file category — ports of
 * the Node `FileProcessingService` helpers (`detectMimeFromMagicBytes`,
 * `verifyMagicBytes`, `categorizeFile`, `isDocumentType`, `isPlainTextType`).
 *
 * Note the two taxonomies deliberately differ, as on Node: `classify.ts`
 * drives ROUTING (plain text is its own kind), while `FileCategory` drives
 * EXTRACTION (plain text counts as a document that is read locally).
 */

export type FileCategory =
  | 'document'
  | 'image'
  | 'audio'
  | 'video'
  | 'unsupported';

const MAGIC_BYTES: Array<{ bytes: number[]; offset?: number; mime: string }> = [
  // Images
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' },
  { bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' }, // RIFF (WebP container)
  { bytes: [0x42, 0x4d], mime: 'image/bmp' },
  { bytes: [0x49, 0x49, 0x2a, 0x00], mime: 'image/tiff' },
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], mime: 'image/tiff' },
  // Documents
  { bytes: [0x25, 0x50, 0x44, 0x46], mime: 'application/pdf' },
  { bytes: [0x50, 0x4b, 0x03, 0x04], mime: 'application/zip' }, // docx/xlsx/…
  { bytes: [0xd0, 0xcf, 0x11, 0xe0], mime: 'application/msword' }, // OLE2
  // Audio
  { bytes: [0x49, 0x44, 0x33], mime: 'audio/mpeg' }, // ID3
  { bytes: [0xff, 0xfb], mime: 'audio/mpeg' },
  { bytes: [0xff, 0xf3], mime: 'audio/mpeg' },
  { bytes: [0x4f, 0x67, 0x67, 0x53], mime: 'audio/ogg' },
  { bytes: [0x66, 0x4c, 0x61, 0x43], mime: 'audio/flac' },
  // Video
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], mime: 'video/webm' }, // EBML (WebM/MKV)
  { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4, mime: 'video/mp4' }, // `ftyp`
];

const MAGIC_MIME_CATEGORIES: Record<string, FileCategory[]> = {
  'image/png': ['image'],
  'image/jpeg': ['image'],
  'image/gif': ['image'],
  'image/webp': ['image'],
  'image/bmp': ['image'],
  'image/tiff': ['image'],
  'application/pdf': ['document'],
  'application/zip': ['document'],
  'application/msword': ['document'],
  'audio/mpeg': ['audio'],
  'audio/ogg': ['audio'],
  'audio/flac': ['audio'],
  'video/webm': ['video', 'audio'],
  'video/mp4': ['video', 'audio'],
};

/** The MIME a file's magic bytes announce, or null when no signature matches. */
export function detectMimeFromMagicBytes(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  for (const sig of MAGIC_BYTES) {
    const offset = sig.offset ?? 0;
    if (bytes.length < offset + sig.bytes.length) continue;
    let match = true;
    for (let i = 0; i < sig.bytes.length; i += 1) {
      if (bytes[offset + i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) return sig.mime;
  }
  return null;
}

export function isPlainTextType(mimetype: string): boolean {
  return (
    mimetype.startsWith('text/') ||
    mimetype === 'application/json' ||
    mimetype === 'application/xml' ||
    mimetype === 'application/rtf'
  );
}

export function isDocumentType(mimetype: string): boolean {
  return (
    mimetype.startsWith('text/') ||
    mimetype === 'application/pdf' ||
    mimetype === 'application/msword' ||
    mimetype === 'application/json' ||
    mimetype === 'application/xml' ||
    mimetype === 'application/rtf' ||
    mimetype.startsWith('application/vnd.openxmlformats-officedocument.') ||
    mimetype === 'application/vnd.ms-excel' ||
    mimetype === 'application/vnd.ms-powerpoint'
  );
}

export function categorizeFile(mimetype: string): FileCategory {
  if (isDocumentType(mimetype)) return 'document';
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('audio/')) return 'audio';
  if (mimetype.startsWith('video/')) return 'video';
  return 'unsupported';
}

/**
 * Verify that the bytes are consistent with the claimed category. Strict for
 * binary formats; skipped for text-based mimetypes (no reliable signature).
 * Throws on a mismatch (e.g. an executable claiming to be a PNG).
 */
export function verifyMagicBytes(
  bytes: Uint8Array,
  claimedCategory: FileCategory,
  attachment: { mimetype: string; filename: string },
  warn?: (message: string) => void,
): void {
  if (isPlainTextType(attachment.mimetype)) return;
  const detected = detectMimeFromMagicBytes(bytes);
  if (!detected) {
    warn?.(
      `No magic bytes match for ${attachment.filename} (claimed: ${attachment.mimetype})`,
    );
    return;
  }
  const allowed = MAGIC_MIME_CATEGORIES[detected];
  if (!allowed || !allowed.includes(claimedCategory)) {
    throw new Error(
      `File content mismatch: claimed ${attachment.mimetype} but detected ${detected}`,
    );
  }
}
