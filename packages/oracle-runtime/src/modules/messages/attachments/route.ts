import type { ModelInputCapabilities } from '../../../llm/model-catalog.js';
import type { AttachmentKind } from './classify.js';

/**
 * How an attachment reaches the model:
 * - `parse-local`   — read to text ourselves (free). Plain-text files only.
 * - `send-native`   — attach the raw bytes to the user message; the selected
 *                     model reads it directly. Only when the model accepts that
 *                     modality.
 * - `model-extract` — the helper (vision) model turns it into text first. Used
 *                     for anything the selected model can't accept natively.
 */
export type AttachmentStrategy =
  | 'parse-local'
  | 'send-native'
  | 'model-extract';

/**
 * Decide, for one attachment, how to get it to the selected model — the single
 * cost-aware, capability-aware routing rule. Pure and total.
 *
 * The bias is cost-first: plain text is always read locally; everything else is
 * sent native only when the model can actually eat it, otherwise it is turned
 * into text by the helper model (which is also the only option for text-only
 * models).
 */
export function routeAttachment(
  kind: AttachmentKind,
  caps: ModelInputCapabilities,
): AttachmentStrategy {
  switch (kind) {
    case 'text':
      return 'parse-local';
    case 'image':
      return caps.image ? 'send-native' : 'model-extract';
    case 'document':
      return caps.file ? 'send-native' : 'model-extract';
    case 'audio':
      return caps.audio ? 'send-native' : 'model-extract';
    case 'video':
      return caps.video ? 'send-native' : 'model-extract';
    case 'unknown':
    default:
      return 'model-extract';
  }
}
