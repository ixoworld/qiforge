import { z } from 'zod';
import type {
  OwnerCallbackResult,
  UserKvSurface,
} from '../../plugin-api/types';
import {
  isVerificationUnavailable,
  verifyDelivery,
  type CheckOutcome,
  type VerifierContext,
} from './verifier';

/**
 * A credential check's state in the person's own kv (namespace
 * `credentials`):
 *
 * - `check:<checkId>`: the request object and the private key its answer is
 *   encrypted to, the person, the query, the worker's request id.
 * - `open:<query hash>`: the check a repeated call with the same fields
 *   continues.
 * - `result:<checkId>`: the ONE verified answer, written by the person's
 *   object when the wallet's answer arrives (`receiveAnswer`); a second
 *   verified answer is ignored, junk is never stored.
 * - `checks`: the index housekeeping prunes (every check ends within its
 *   15 minutes, answered or not).
 */

export const CREDENTIALS_KV_NAMESPACE = 'credentials';
const INDEX_KEY = 'checks';
/** Most checks the index tracks for one person (oldest pruned first). */
const MAX_INDEXED_CHECKS = 32;

export const checkKey = (checkId: string) => `check:${checkId}`;
export const openKey = (queryHash: string) => `open:${queryHash}`;
export const resultKey = (checkId: string) => `result:${checkId}`;

export const CheckRow = z.object({
  v: z.literal(1),
  checkId: z.string(),
  queryHash: z.string(),
  /** Unix seconds. */
  expiresAt: z.number(),
  subject: z.string(),
  query: z.object({
    vct: z.string(),
    issuers: z.array(z.string()),
    claims: z.array(z.string()),
  }),
  requestJwt: z.string(),
  privateJwk: z.object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string(),
    y: z.string(),
    d: z.string(),
    kid: z.string().optional(),
    use: z.literal('enc').optional(),
    alg: z.literal('ECDH-ES').optional(),
  }),
  requestId: z.string().optional(),
  walletUrl: z.string().optional(),
});
export type CheckRow = z.infer<typeof CheckRow>;

const StoredOutcome = z.discriminatedUnion('result', [
  z.object({
    result: z.literal('valid'),
    claims: z.record(z.string(), z.unknown()),
    issuer: z.string(),
  }),
  z.object({
    result: z.enum(['invalid', 'revoked', 'expired']),
    code: z.string(),
  }),
]);

const Index = z.array(
  z.object({
    checkId: z.string(),
    queryHash: z.string(),
    expiresAt: z.number(),
  }),
);

/** How long the kv keeps a check's rows without a read or a write. */
export function checkIdleTtlMs(
  expiresAtSeconds: number,
  nowMs: number,
): number {
  return Math.max(1_000, expiresAtSeconds * 1000 - nowMs) + 60_000;
}

export async function readCheck(
  kv: UserKvSurface,
  checkId: string,
): Promise<CheckRow | null> {
  const parsed = CheckRow.safeParse(
    await kv.get(CREDENTIALS_KV_NAMESPACE, checkKey(checkId)),
  );
  return parsed.success ? parsed.data : null;
}

export async function readResult(
  kv: UserKvSurface,
  checkId: string,
): Promise<CheckOutcome | null> {
  const parsed = StoredOutcome.safeParse(
    await kv.get(CREDENTIALS_KV_NAMESPACE, resultKey(checkId)),
  );
  return parsed.success ? parsed.data : null;
}

/** Store a new check and index it. */
export async function saveCheck(
  kv: UserKvSurface,
  row: CheckRow,
  nowMs: number,
): Promise<void> {
  const idleTtlMs = checkIdleTtlMs(row.expiresAt, nowMs);
  await kv.set(CREDENTIALS_KV_NAMESPACE, checkKey(row.checkId), row, {
    idleTtlMs,
  });
  await kv.update(
    CREDENTIALS_KV_NAMESPACE,
    INDEX_KEY,
    (current) => {
      const index = Index.safeParse(current);
      const rows = (index.success ? index.data : []).filter(
        (entry) => entry.checkId !== row.checkId,
      );
      rows.push({
        checkId: row.checkId,
        queryHash: row.queryHash,
        expiresAt: row.expiresAt,
      });
      return rows.slice(-MAX_INDEXED_CHECKS);
    },
    { idleTtlMs: 24 * 3600 * 1000 },
  );
}

/** Delete every row of one check. */
export async function deleteCheck(
  kv: UserKvSurface,
  row: Pick<CheckRow, 'checkId' | 'queryHash'>,
): Promise<void> {
  await kv.delete(CREDENTIALS_KV_NAMESPACE, checkKey(row.checkId));
  await kv.delete(CREDENTIALS_KV_NAMESPACE, resultKey(row.checkId));
  const open = await kv.get(CREDENTIALS_KV_NAMESPACE, openKey(row.queryHash));
  if (open === row.checkId)
    await kv.delete(CREDENTIALS_KV_NAMESPACE, openKey(row.queryHash));
}

/** Housekeeping: delete the rows of every check that has ended. */
export async function pruneEndedChecks(
  kv: UserKvSurface,
  nowSeconds: number,
): Promise<void> {
  const index = Index.safeParse(
    await kv.get(CREDENTIALS_KV_NAMESPACE, INDEX_KEY),
  );
  if (!index.success) return;
  const ended = index.data.filter((entry) => entry.expiresAt <= nowSeconds);
  if (ended.length === 0) return;
  for (const entry of ended) await deleteCheck(kv, entry);
  const endedIds = new Set(ended.map((entry) => entry.checkId));
  await kv.update(
    CREDENTIALS_KV_NAMESPACE,
    INDEX_KEY,
    (current) => {
      const parsed = Index.safeParse(current);
      return parsed.success
        ? parsed.data.filter((entry) => !endedIds.has(entry.checkId))
        : current;
    },
    { idleTtlMs: 24 * 3600 * 1000 },
  );
}

const answer = (
  status: OwnerCallbackResult['status'],
  error?: string,
  message?: string,
): OwnerCallbackResult =>
  error ? { status, body: { error, message: message ?? error } } : { status };

/**
 * The wallet's answer to one check, run in the person's object (the only
 * place that holds the check's private key and request): decrypt it and
 * verify it with the kit (state, nonce, audience, key binding, issuer,
 * status, `expectedSubject` = the person). Only an answer that proves to
 * come from the person is stored, once; anything else is refused with 400
 * and leaves nothing behind.
 */
export async function receiveAnswer(input: {
  kv: UserKvSurface;
  ownerDid: string;
  checkId: string;
  body: string;
  verifier: VerifierContext;
  nowMs: number;
}): Promise<OwnerCallbackResult> {
  const { kv } = input;
  const row = await readCheck(kv, input.checkId);
  if (
    !row ||
    row.subject !== input.ownerDid ||
    row.expiresAt * 1000 <= input.nowMs
  )
    return answer(410, 'check_closed', 'This check has already ended.');
  // One answer per check: a second one changes nothing.
  if (await readResult(kv, row.checkId)) return answer(200);
  let outcome: CheckOutcome | null;
  try {
    outcome = await verifyDelivery({
      verifier: input.verifier,
      body: input.body,
      requestJwt: row.requestJwt,
      privateJwk: row.privateJwk,
      subject: row.subject,
      query: row.query,
    });
  } catch (error) {
    if (isVerificationUnavailable(error))
      return answer(503, 'unavailable', 'Please try again in a moment.');
    throw error;
  }
  if (!outcome)
    return answer(
      400,
      'invalid_response',
      'This is not an answer to this check.',
    );
  await kv.update(
    CREDENTIALS_KV_NAMESPACE,
    resultKey(row.checkId),
    (current) => current ?? outcome,
    { idleTtlMs: checkIdleTtlMs(row.expiresAt, input.nowMs) },
  );
  return answer(200);
}
