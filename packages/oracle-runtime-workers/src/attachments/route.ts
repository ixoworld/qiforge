import type { ModelInputCapabilities } from '../core/llm';
import type { AttachmentKind } from './classify';

/**
 * How an attachment reaches the model:
 * - `parse-local`   — read to text ourselves (free). Plain-text files only.
 * - `send-native`   — attach the raw bytes to the user message; the selected
 *                     model reads it directly. Only when the model accepts that
 *                     modality and, for a document, the file is not declared
 *                     too large (the caller checks the downloaded length).
 * - `model-extract` — the helper (vision) model turns it into text first. Used
 *                     for anything the selected model can't accept natively,
 *                     and for documents over {@link NATIVE_DOCUMENT_MAX_BYTES}.
 */
export type AttachmentStrategy =
  | 'parse-local'
  | 'send-native'
  | 'model-extract';

/**
 * The largest document sent to the model as a native file block (20 KiB).
 * The block is the file's base64, which the runtime counts as tokens at
 * chars/4: 20,480 bytes are ~27k base64 chars ≈ 7k tokens by that estimate.
 * Providers charge a native PDF per page, so this keeps a native document
 * to a few pages. A larger document
 * always goes through the extract lane: its text from the helper model (cut
 * at 50k chars), a sandbox copy and a 500-char inline excerpt with the
 * sandbox path.
 */
export const NATIVE_DOCUMENT_MAX_BYTES = 20_480;

/**
 * Decide, for one attachment, how to get it to the selected model — the single
 * cost-aware, capability-aware routing rule. Pure and total.
 *
 * Documents are routed by SIZE (`opts.size`, the declared byte length), the
 * same for every source (Portal, Matrix, chat channels): a native file block
 * is replayed to the model on every later turn and held in the user's
 * checkpoint, so its cost grows with the file, not with where it came from.
 * A document is a native candidate when the model reads files AND its
 * declared size is unknown or at most {@link NATIVE_DOCUMENT_MAX_BYTES}; only
 * a KNOWN size over the limit goes straight to `model-extract`, which skips
 * the native download. For a candidate the downloaded byte length decides
 * (the pipeline and `view.ts`): at most the limit is sent natively, more goes
 * to the extract lane with the bytes already loaded. So an unsized small
 * file still goes natively, and a declared size that is wrong cannot slip a
 * large one through.
 *
 * Images go native whenever the model reads images, whatever their size:
 * they are downscaled before the model sees them (`resize.ts`) when the
 * oracle binds Cloudflare Images. Audio, video, text and unknown files are
 * routed by capability alone.
 */
export function routeAttachment(
  kind: AttachmentKind,
  caps: ModelInputCapabilities,
  opts: { size?: number } = {},
): AttachmentStrategy {
  switch (kind) {
    case 'text':
      return 'parse-local';
    case 'image':
      return caps.image ? 'send-native' : 'model-extract';
    case 'document':
      return caps.file && mayFitNativeDocument(opts.size)
        ? 'send-native'
        : 'model-extract';
    case 'audio':
      return caps.audio ? 'send-native' : 'model-extract';
    case 'video':
      return caps.video ? 'send-native' : 'model-extract';
    case 'unknown':
    default:
      return 'model-extract';
  }
}

/**
 * Whether a document declared at `size` bytes may go as a native file block:
 * unknown counts as maybe, and the downloaded length decides.
 */
function mayFitNativeDocument(size: number | undefined): boolean {
  return size === undefined || size <= NATIVE_DOCUMENT_MAX_BYTES;
}
