/**
 * Transaction ids for Matrix sends that may be retried across a gateway
 * restart. The homeserver deduplicates sends by transaction id per device,
 * so a caller that re-sends with the same id after a lost response gets the
 * original event back instead of a duplicate. Synapse accepts ids without
 * whitespace, control characters or `/`, up to 255 bytes. The parts joined
 * here (event ids, session ids, request ids, run ids) are ASCII; `/` and `+`
 * of standard-base64 event ids are mapped so distinct ids stay distinct, and
 * anything outside printable ASCII is dropped.
 */
export const MAX_TXN_ID_LENGTH = 255;

export function matrixTxnId(prefix: string, ...parts: string[]): string {
  let out = prefix;
  for (const part of parts) {
    out += '-';
    for (const ch of part) {
      const code = ch.charCodeAt(0);
      if (ch === '/') out += '_';
      else if (ch === '+') out += '-';
      else if (code > 0x20 && code < 0x7f) out += ch;
    }
  }
  return out.slice(0, MAX_TXN_ID_LENGTH);
}

/**
 * A transaction id for a best-effort post whose retries all live in one
 * in-memory loop (an audit entry, a prompt): fixed for the life of that loop,
 * so a response lost after the homeserver accepted the event is deduplicated
 * instead of posted twice, and fresh for every new post.
 */
export function retryTxnId(prefix: string): string {
  return matrixTxnId(prefix, crypto.randomUUID());
}
