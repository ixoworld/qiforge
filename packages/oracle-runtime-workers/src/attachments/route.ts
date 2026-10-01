import type { ModelInputCapabilities } from '../core/llm';
import type { AttachmentKind } from './classify';

/**
 * How an attachment reaches the model (verbatim port of the Node rule):
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
