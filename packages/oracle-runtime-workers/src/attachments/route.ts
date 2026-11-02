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
 *
 * `channelFile`: a file from a chat channel (WhatsApp) never goes as raw
 * bytes. Its message is replayed to the model on every later turn and kept in
 * the user's checkpoint, so a native PDF or photo there is base64 the size of
 * the file, counted as tokens at chars/4 and held several times over in the
 * object's 128 MB isolate (a 600 KB PDF reset the isolate on every attempt).
 * The helper model turns it into text instead; tools still read the file
 * itself through `ctx.session.channel.attachments`.
 */
export function routeAttachment(
  kind: AttachmentKind,
  caps: ModelInputCapabilities,
  options: { channelFile?: boolean } = {},
): AttachmentStrategy {
  if (options.channelFile)
    return kind === 'text' ? 'parse-local' : 'model-extract';
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
