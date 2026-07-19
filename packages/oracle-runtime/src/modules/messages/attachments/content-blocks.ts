import type {
  MessageContent,
  MessageContentComplex,
} from '@langchain/core/messages';

/**
 * An attachment we send to the model natively (base64). Only `image` and `file`
 * are wired today — the proven LangChain→OpenRouter path (see `vfs-content.ts`).
 */
export interface NativeAttachment {
  kind: 'image' | 'file';
  mimeType: string;
  base64: string;
  filename: string;
}

/**
 * Build the user message `content`. With no native attachments it stays a plain
 * string (unchanged behaviour). Otherwise it becomes a LangChain "data content
 * block" array: the text, then one block per attachment.
 *
 * The blocks MUST use `source_type: 'base64'` + snake_case `mime_type` — that is
 * the only shape the `@langchain/openai` completions converter (the OpenRouter
 * path) recognises; it emits `image_url: data:<mime>;base64,<data>` for images
 * and `file_data` for files. camelCase or a missing `source_type` silently
 * drops the attachment.
 */
export function buildUserMessageContent(
  text: string,
  natives: NativeAttachment[],
): MessageContent {
  if (natives.length === 0) return text;

  const blocks: MessageContentComplex[] = [{ type: 'text', text }];
  for (const native of natives) {
    if (native.kind === 'image') {
      blocks.push({
        type: 'image',
        source_type: 'base64',
        mime_type: native.mimeType,
        data: native.base64,
      });
    } else {
      blocks.push({
        type: 'file',
        source_type: 'base64',
        mime_type: native.mimeType,
        data: native.base64,
        filename: native.filename,
      });
    }
  }
  return blocks;
}
