/**
 * Upper bound on a chat turn's request body (`POST /messages/:sessionId`).
 *
 * The cap bounds the memory one request can pin: the shell enforces it
 * before reading the body (`bodyLimit` — the declared length, or a count of
 * the streamed bytes), so an oversized body is refused with 413 without
 * ever being buffered. It no longer mirrors the Node runtime, which keeps
 * Express body-parser's 100 kb default — a normal Portal turn now exceeds
 * that. Every turn carries the browser-tool catalogue (26–32 tools, 65–70
 * KiB of JSON schema) and the AG-UI action schemas (~27 KiB) before the
 * message text, and a compose-topic turn adds the pinned text in
 * `metadata.contextToolCall`; on devnet turns of 102–115 KiB were refused.
 * 256 KiB leaves room for those. Attachments never count: files go to
 * Matrix media first and the body carries only their references. The cap
 * counts UTF-8 bytes, as the wire carries them.
 */
export const MAX_TURN_BODY_BYTES = 256 * 1024;
