/**
 * Upper bound on a chat turn's request body (`POST /messages/:sessionId`).
 *
 * The cap bounds the memory one request can pin: the shell reads the body in
 * full before forwarding it to the user object. It no longer mirrors the Node
 * runtime, which keeps Express body-parser's 100 kb default — a normal Portal
 * turn now exceeds that. Every turn carries the browser-tool catalogue (26–32
 * tools, 65–70 KiB of JSON schema) and the AG-UI action schemas (~27 KiB)
 * before the message text, and a compose-topic turn adds the pinned text in
 * `metadata.contextToolCall`; on devnet turns of 102–115 KiB were refused.
 * 256 KiB leaves room for those. Attachments never count: files go to Matrix
 * media first and the body carries only their references.
 */
export const MAX_TURN_BODY_BYTES = 256 * 1024;

/** Whether a raw body is over the cap, measured as the UTF-8 bytes the wire carried. */
export function turnBodyTooLarge(body: string): boolean {
  return new TextEncoder().encode(body).byteLength > MAX_TURN_BODY_BYTES;
}

export async function readBoundedBody(
  request: Request,
  limit = MAX_TURN_BODY_BYTES,
): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await request.body?.cancel();
    return null;
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
