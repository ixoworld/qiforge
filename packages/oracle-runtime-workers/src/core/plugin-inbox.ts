import type { UserKvSurface } from '../plugin-api/types';

/**
 * A plugin inbox: one row in the user's own key-value store (`ctx.kv`) that
 * a public callback may append to, for a reply that arrives over HTTP while
 * (or after) a tool waits for it. A verifier's OpenID4VP `response_uri` is
 * one: the wallet POSTs the answer there, and the tool that made the request
 * reads it from the user's object.
 *
 * A plugin opens the row before it hands out the callback URL; the user
 * object appends a delivery only to an open, unexpired row
 * (`deliverToPluginInbox`, called through the object's
 * `deliverPluginInbox` RPC). Nothing else is written, so a caller who did
 * not get the URL, or one who calls after the row closed, changes nothing.
 * Deliveries are kept as received: the plugin authenticates each one itself
 * (decrypts it, checks its signature) before it trusts any of it, and drops
 * the ones that fail (`dropFromPluginInbox`). A full row makes room by
 * dropping its oldest delivery, so junk sent first can never lock the real
 * answer out.
 */

/** Most deliveries one inbox row may hold. */
export const PLUGIN_INBOX_MAX_DELIVERIES = 8;
/** Largest single delivery, in characters (the user kv caps a row at 256 KiB). */
export const PLUGIN_INBOX_MAX_BODY_LENGTH = 24 * 1024;

export interface PluginInboxRow {
  v: 1;
  /** Unix ms after which nothing is appended. */
  expiresAt: number;
  /** Most deliveries this row accepts (at most `PLUGIN_INBOX_MAX_DELIVERIES`). */
  max: number;
  deliveries: string[];
}

export function isPluginInboxRow(value: unknown): value is PluginInboxRow {
  if (value === null || typeof value !== 'object') return false;
  const deliveries: unknown = Reflect.get(value, 'deliveries');
  return (
    Reflect.get(value, 'v') === 1 &&
    typeof Reflect.get(value, 'expiresAt') === 'number' &&
    typeof Reflect.get(value, 'max') === 'number' &&
    Array.isArray(deliveries) &&
    deliveries.every((item) => typeof item === 'string')
  );
}

/** How long the user kv keeps an inbox row without a read or a write. */
function idleTtlMs(expiresAt: number, now: number): number {
  // A minute past its end, so a late read still sees the deliveries.
  return Math.max(1, expiresAt - now) + 60_000;
}

/** Open (or reset) an inbox row that accepts deliveries until `expiresAt`. */
export async function openPluginInbox(
  kv: UserKvSurface,
  namespace: string,
  key: string,
  opts: { expiresAt: number; max?: number; now?: number },
): Promise<void> {
  const now = opts.now ?? Date.now();
  const max = Math.min(
    Math.max(1, Math.floor(opts.max ?? PLUGIN_INBOX_MAX_DELIVERIES)),
    PLUGIN_INBOX_MAX_DELIVERIES,
  );
  const row: PluginInboxRow = {
    v: 1,
    expiresAt: opts.expiresAt,
    max,
    deliveries: [],
  };
  await kv.set(namespace, key, row, {
    idleTtlMs: idleTtlMs(opts.expiresAt, now),
  });
}

/** The deliveries of an inbox row, oldest first; `[]` when there is no row. */
export async function readPluginInbox(
  kv: UserKvSurface,
  namespace: string,
  key: string,
): Promise<string[]> {
  const row = await kv.get(namespace, key);
  return isPluginInboxRow(row) ? row.deliveries : [];
}

/**
 * Append `body` to an open inbox row, dropping the oldest delivery when the
 * row is full. `true` when it was stored; `false` when there is no such row,
 * it has ended, or `body` is empty or too large. Never creates a row.
 */
export async function deliverToPluginInbox(
  kv: UserKvSurface,
  namespace: string,
  key: string,
  body: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (body.length === 0 || body.length > PLUGIN_INBOX_MAX_BODY_LENGTH)
    return false;
  const open = (row: unknown): row is PluginInboxRow =>
    isPluginInboxRow(row) && row.expiresAt > now;
  // The read gives the row's lifetime, which the write keeps (a write
  // without `idleTtlMs` would clear the row's idle deadline). Nothing is
  // written for a caller without an open row.
  const seen = await kv.get(namespace, key);
  if (!open(seen)) return false;
  let accepted = false;
  await kv.update(
    namespace,
    key,
    (current) => {
      // `update` may run this again on a retried read: decide from scratch.
      accepted = open(current);
      if (!accepted || !isPluginInboxRow(current)) return current;
      const kept = current.deliveries.slice(
        Math.max(0, current.deliveries.length - current.max + 1),
      );
      return { ...current, deliveries: [...kept, body] };
    },
    { idleTtlMs: idleTtlMs(seen.expiresAt, now) },
  );
  return accepted;
}

/**
 * Drop deliveries the plugin could not authenticate (each first match of a
 * body in `bodies`), keeping the row and its lifetime.
 */
export async function dropFromPluginInbox(
  kv: UserKvSurface,
  namespace: string,
  key: string,
  bodies: readonly string[],
  now: number = Date.now(),
): Promise<void> {
  if (bodies.length === 0) return;
  const seen = await kv.get(namespace, key);
  if (!isPluginInboxRow(seen)) return;
  await kv.update(
    namespace,
    key,
    (current) => {
      if (!isPluginInboxRow(current)) return current;
      const left = [...bodies];
      const deliveries = current.deliveries.filter((item) => {
        const index = left.indexOf(item);
        if (index < 0) return true;
        left.splice(index, 1);
        return false;
      });
      return { ...current, deliveries };
    },
    { idleTtlMs: idleTtlMs(seen.expiresAt, now) },
  );
}
