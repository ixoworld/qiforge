/**
 * What a `chain_lookup` answer looks like to the model: every Blocksync
 * row cut down to the fields a question needs, every nested list capped,
 * and message values summarised (a bank send as from/to/amount, a claim
 * message as its claim and collection, anything else as a short excerpt) —
 * never a raw value blob. Every string from the index is chain data
 * written by anyone and is clipped: ids 120 characters, names and labels
 * 200, memos 256, excerpts 240. Bank coins are `{ denom, amountBaseUnits }`
 * (never `amount`, which `get_account_balances` uses for converted units);
 * 1155 token amounts are whole units and stay `amount`.
 */
import { z } from 'zod';
import type { Failure } from './http';
import type { ChainRequest } from './queries';

export type Coin = { denom: string; amountBaseUnits: string };

export type MessageSummary =
  | { type: 'MsgSend'; from?: string; to?: string; amount: Coin[] }
  | {
      type: 'MsgTransferToken';
      from?: string;
      to?: string;
      tokens: { id: string; amount: string }[];
    }
  | {
      type: 'MsgSubmitClaim' | 'MsgEvaluateClaim';
      claimId?: string;
      collectionId?: string;
      status?: string;
    }
  | { type: 'MsgExec'; messages: MessageSummary[]; count: number }
  | { type: string; excerpt: string };

export const EXCERPT_CHARS = 240;
export const ID_CHARS = 120;
export const TEXT_CHARS = 200;
export const MEMO_CHARS = 256;
const LIST_CAP = 20;
const COIN_CAP = 10;
const EXEC_CAP = 5;

/** x/claims `EvaluationStatus`. */
const EVALUATION_STATUS = [
  'pending',
  'approved',
  'rejected',
  'disputed',
  'invalidated',
  'flagged',
] as const;
/** x/claims `CollectionState`. */
const COLLECTION_STATE = ['open', 'paused', 'closed'] as const;

export const TOKEN_DECIMALS_NOTE =
  'IXO 1155 tokens have no decimals on chain: amounts are whole units.';
/** x/entity defines no status values: `status` is a number its creator gives meaning to. */
export const ENTITY_STATUS_NOTE =
  'Entity status is a number its creator defines; the chain gives it no fixed meaning.';
/** `entities` reads `ID_DESC`, and an entity id is a hash: the order says nothing about age. */
export const ENTITIES_ORDER = 'id (text)';

/** `text` cut to `max` characters, the last one an ellipsis when cut. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A non-empty string field, clipped; undefined otherwise. */
export function text(value: unknown, max = TEXT_CHARS): string | undefined {
  return typeof value === 'string' && value ? clip(value, max) : undefined;
}

/** The first of `keys` present as a non-empty string (camelCase first, then snake_case). */
function field(
  value: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const found = text(value[key]);
    if (found) return found;
  }
  return undefined;
}

/** Drops undefined entries so absent fields cost nothing in the answer. */
function compact<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value))
    if (value[key] === undefined) delete value[key];
  return value;
}

/** An amount (string or number) as clipped text; undefined otherwise. */
function amountText(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number'
    ? clip(String(value), 80)
    : undefined;
}

/** `[{ denom, amountBaseUnits }]` from bank coins, at most `max`; anything else is left out. */
function coins(value: unknown, max = COIN_CAP): Coin[] {
  if (!Array.isArray(value)) return [];
  const out: Coin[] = [];
  for (const entry of value) {
    if (out.length >= max) break;
    if (!isRecord(entry)) continue;
    const denom = text(entry.denom, ID_CHARS);
    const amountBaseUnits = amountText(entry.amount);
    if (denom && amountBaseUnits) out.push({ denom, amountBaseUnits });
  }
  return out;
}

function evaluationStatus(value: unknown): string | undefined {
  if (typeof value === 'number')
    return EVALUATION_STATUS[value] ?? `unknown (${value})`;
  if (typeof value === 'string' && value)
    return clip(value.replace(/^EVALUATION_STATUS_/, '').toLowerCase(), 40);
  return undefined;
}

function collectionState(value: unknown): string | undefined {
  return typeof value === 'number'
    ? (COLLECTION_STATE[value] ?? `unknown (${value})`)
    : undefined;
}

const shortType = (typeUrl: string) =>
  clip(typeUrl.slice(typeUrl.lastIndexOf('.') + 1) || typeUrl, 80);

function excerpt(value: unknown): string {
  return clip(JSON.stringify(value) ?? '', EXCERPT_CHARS);
}

/**
 * A message as the model reads it. An authz `MsgExec` is stored as the
 * array of its inner `{ typeUrl, value }` messages; its first five are
 * summarised (one level deep).
 */
export function summarizeMessage(
  typeUrl: string,
  value: unknown,
  depth = 0,
): MessageSummary {
  const type = shortType(typeUrl);
  if (typeUrl === '/cosmos.authz.v1beta1.MsgExec' && Array.isArray(value)) {
    const inner = value.filter(isRecord);
    return {
      type: 'MsgExec',
      count: inner.length,
      messages: inner
        .slice(0, EXEC_CAP)
        .map((message) =>
          depth === 0 && typeof message.typeUrl === 'string'
            ? summarizeMessage(message.typeUrl, message.value, depth + 1)
            : { type: 'message', excerpt: excerpt(message) },
        ),
    };
  }
  if (!isRecord(value)) return { type, excerpt: excerpt(value) };
  switch (typeUrl) {
    case '/cosmos.bank.v1beta1.MsgSend': {
      const summary: MessageSummary = {
        type: 'MsgSend',
        from: field(value, 'fromAddress', 'from_address'),
        to: field(value, 'toAddress', 'to_address'),
        amount: coins(value.amount),
      };
      return compact(summary);
    }
    case '/ixo.token.v1beta1.MsgTransferToken': {
      const summary: MessageSummary = {
        type: 'MsgTransferToken',
        from: field(value, 'owner'),
        to: field(value, 'recipient'),
        tokens: Array.isArray(value.tokens)
          ? value.tokens
              .filter(isRecord)
              .slice(0, COIN_CAP)
              .flatMap((token) => {
                const id = text(token.id, ID_CHARS);
                const amount = amountText(token.amount);
                return id && amount ? [{ id, amount }] : [];
              })
          : [],
      };
      return compact(summary);
    }
    case '/ixo.claims.v1beta1.MsgSubmitClaim':
    case '/ixo.claims.v1beta1.MsgEvaluateClaim': {
      const summary: MessageSummary = {
        type:
          typeUrl === '/ixo.claims.v1beta1.MsgSubmitClaim'
            ? 'MsgSubmitClaim'
            : 'MsgEvaluateClaim',
        claimId: field(value, 'claimId', 'claim_id'),
        collectionId: field(value, 'collectionId', 'collection_id'),
        status:
          typeUrl === '/ixo.claims.v1beta1.MsgEvaluateClaim'
            ? evaluationStatus(value.status)
            : undefined,
      };
      return compact(summary);
    }
    default:
      return { type, excerpt: excerpt(value) };
  }
}

/* ── per-kind shaping ──────────────────────────────────────────────────── */

/**
 * A request's answer. `ownedBy` (by-id kinds) lists the accounts whose
 * record it is — a claim's agent, a collection's admin, an entity's owner,
 * a transaction's signers — so the caller can say whether it is the user's.
 */
export type Shaped =
  | { ok: true; data: unknown; ownedBy?: string[] }
  | { ok: false; failure: Failure };

const unexpected: Failure = {
  reason: 'unavailable',
  detail: 'Blocksync answered this request in an unexpected shape.',
  retryable: false,
};
const notFound = (what: string): Failure => ({
  reason: 'not_found',
  detail: `No ${what} with that id is indexed.`,
  retryable: false,
});

const str = z.string();
const opt = z.string().nullish();
const num = z.union([z.string(), z.number()]).nullish();

const evaluationNode = z.looseObject({
  status: z.number().nullish(),
  evaluationDate: opt,
  oracle: opt,
  agentDid: opt,
  agentAddress: opt,
  reason: num,
  amount: z.unknown().optional(),
});
const claimNode = z.looseObject({
  claimId: str,
  collectionId: str,
  agentDid: opt,
  agentAddress: opt,
  submissionDate: opt,
  paymentsStatus: z.unknown().optional(),
  schemaType: opt,
  useIntent: z.boolean().nullish(),
  amount: z.unknown().optional(),
  currentEvaluationId: num,
  evaluation: evaluationNode.nullish(),
});
const collectionNode = z.looseObject({
  id: str,
  entity: opt,
  admin: opt,
  protocol: opt,
  startDate: opt,
  endDate: opt,
  quota: num,
  count: num,
  evaluated: num,
  approved: num,
  rejected: num,
  disputed: num,
  state: z.number().nullish(),
  payments: z.unknown().optional(),
});
const messageNode = z.looseObject({
  typeUrl: str,
  index: z.number().nullish(),
  value: z.unknown().optional(),
});
const transactionNode = z.looseObject({
  hash: str,
  height: z.number(),
  time: opt,
  code: z.number(),
  memo: opt,
  fee: z.unknown().optional(),
  transactionSignersByTransactionId: z
    .object({ nodes: z.array(z.object({ signerAddress: str })) })
    .nullish(),
  messagesByTransactionHash: z
    .object({ totalCount: z.number(), nodes: z.array(messageNode) })
    .nullish(),
});
const connection = <T extends z.ZodType>(node: T) =>
  z.looseObject({
    totalCount: z.number().optional(),
    pageInfo: z
      .object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() })
      .optional(),
    nodes: z.array(node),
  });

const nonEmpty = <T>(list: T[]): T[] | undefined =>
  list.length ? list : undefined;

function stringOf(value: string | number | null | undefined) {
  return value === null || value === undefined ? undefined : String(value);
}

/** `paymentsStatus`: leg → status text (`PAID`, `NO_PAYMENT` …). */
function paymentLegs(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 8)
      .flatMap(([leg, status]) =>
        typeof status === 'string' ? [[leg, clip(status, 40)]] : [],
      ),
  );
}

/** An id, address or date from the index, clipped to {@link ID_CHARS}. */
const idText = (value: unknown) => text(value, ID_CHARS);

function evaluationOf(node: z.infer<typeof evaluationNode>) {
  return compact({
    status: evaluationStatus(node.status),
    evaluationDate: idText(node.evaluationDate),
    oracle: idText(node.oracle),
    agentDid: idText(node.agentDid),
    agentAddress: idText(node.agentAddress),
    reason: idText(stringOf(node.reason)),
    amount: nonEmpty(coins(node.amount)),
  });
}

function claimOf(node: z.infer<typeof claimNode>) {
  return compact({
    claimId: idText(node.claimId),
    collectionId: idText(node.collectionId),
    agentDid: idText(node.agentDid),
    agentAddress: idText(node.agentAddress),
    submissionDate: idText(node.submissionDate),
    paymentsStatus: paymentLegs(node.paymentsStatus),
    schemaType: text(node.schemaType),
    useIntent: node.useIntent ?? undefined,
    amount: nonEmpty(coins(node.amount)),
    currentEvaluationId: idText(stringOf(node.currentEvaluationId)),
    evaluation: node.evaluation ? evaluationOf(node.evaluation) : undefined,
  });
}

function collectionOf(node: z.infer<typeof collectionNode>) {
  return compact({
    id: idText(node.id),
    entity: idText(node.entity),
    admin: idText(node.admin),
    protocol: idText(node.protocol),
    startDate: idText(node.startDate),
    endDate: idText(node.endDate),
    quota: idText(stringOf(node.quota)),
    count: idText(stringOf(node.count)),
    evaluated: idText(stringOf(node.evaluated)),
    approved: idText(stringOf(node.approved)),
    rejected: idText(stringOf(node.rejected)),
    disputed: idText(stringOf(node.disputed)),
    state: collectionState(node.state),
  });
}

/** A list of `{ address, amount }` entries (cw20 base units, or 1155 whole units with their token ids). */
function contractPayments(value: unknown, withTokens: boolean) {
  return nonEmpty(
    listOf(value, (entry) =>
      isRecord(entry)
        ? compact({
            address: idText(entry.address),
            ...(withTokens
              ? {
                  tokenIds: nonEmpty(
                    listOf(entry.token_id ?? entry.tokenId, (t) => idText(t)),
                  ),
                  amount: amountText(entry.amount),
                }
              : { amountBaseUnits: amountText(entry.amount) }),
          })
        : undefined,
    ).slice(0, COIN_CAP),
  );
}

/**
 * A collection's `payments` (x/claims `Payments`, as the indexer stores it):
 * per leg (submission, evaluation, approval, rejection) the paying account,
 * bank coins and cw20 amounts in base units, cw1155 amounts in whole units,
 * and whether it is an oracle payment. Both snake_case and camelCase keys
 * are read.
 */
function paymentsOf(value: unknown) {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 8)
      .flatMap(([leg, payment]) => {
        if (!isRecord(payment)) return [];
        const oracle = payment.is_oracle_payment ?? payment.isOraclePayment;
        return [
          [
            clip(leg, 40),
            compact({
              account: idText(payment.account),
              amount: nonEmpty(coins(payment.amount)),
              cw20: contractPayments(
                payment.cw20_payment ?? payment.cw20Payment,
                false,
              ),
              cw1155: contractPayments(
                payment.cw1155_payment ?? payment.cw1155Payment,
                true,
              ),
              oraclePayment: oracle === true ? true : undefined,
            }),
          ],
        ];
      }),
  );
}

/** A linked resource or service: what it is and where, never its body. */
function resourceOf(value: unknown) {
  if (!isRecord(value)) return undefined;
  return compact({
    id: field(value, 'id'),
    type: field(value, 'type'),
    description: field(value, 'description'),
    serviceEndpoint: field(value, 'serviceEndpoint'),
    mediaType: field(value, 'mediaType'),
  });
}

function listOf<T>(value: unknown, map: (item: unknown) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    if (out.length >= LIST_CAP) break;
    const mapped = map(item);
    if (mapped !== undefined) out.push(mapped);
  }
  return out;
}

function transactionOf(
  node: z.infer<typeof transactionNode>,
  messages: z.infer<typeof messageNode>[],
  messageCount?: number,
) {
  return compact({
    hash: idText(node.hash),
    height: node.height,
    time: idText(node.time),
    code: node.code,
    succeeded: node.code === 0,
    memo: text(node.memo, MEMO_CHARS),
    messages: messages.map((m) => summarizeMessage(m.typeUrl, m.value)),
    messageCount:
      messageCount !== undefined && messageCount > messages.length
        ? messageCount
        : undefined,
  });
}

/** The accounts named, without empty values. */
const accounts = (...values: (string | null | undefined)[]): string[] =>
  values.flatMap((value) => (value ? [value] : []));

/** The alias's data as the request kind's answer, or why it has none. */
export function shapeResult(request: ChainRequest, raw: unknown): Shaped {
  switch (request.kind) {
    case 'claims': {
      const parsed = connection(claimNode).safeParse(raw);
      if (!parsed.success) return { ok: false, failure: unexpected };
      const { totalCount, pageInfo, nodes } = parsed.data;
      return {
        ok: true,
        data: compact({
          totalCount,
          hasNextPage: pageInfo?.hasNextPage,
          endCursor: pageInfo?.hasNextPage
            ? (pageInfo.endCursor ?? undefined)
            : undefined,
          items: nodes.map(claimOf),
        }),
      };
    }
    case 'claim': {
      if (raw === null) return { ok: false, failure: notFound('claim') };
      const parsed = claimNode.safeParse(raw);
      return parsed.success
        ? {
            ok: true,
            data: claimOf(parsed.data),
            ownedBy: accounts(parsed.data.agentAddress),
          }
        : { ok: false, failure: unexpected };
    }
    case 'claim_collection': {
      if (raw === null)
        return { ok: false, failure: notFound('claim collection') };
      const parsed = collectionNode.safeParse(raw);
      return parsed.success
        ? {
            ok: true,
            data: compact({
              ...collectionOf(parsed.data),
              payments: paymentsOf(parsed.data.payments),
            }),
            ownedBy: accounts(parsed.data.admin),
          }
        : { ok: false, failure: unexpected };
    }
    case 'claim_collections': {
      const parsed = connection(collectionNode).safeParse(raw);
      if (!parsed.success) return { ok: false, failure: unexpected };
      return {
        ok: true,
        data: compact({
          totalCount: parsed.data.totalCount,
          items: parsed.data.nodes.map(collectionOf),
        }),
      };
    }
    case 'entities': {
      const parsed = connection(
        z.looseObject({
          id: str,
          type: opt,
          status: z.number().nullish(),
          owner: opt,
          metadata: z.unknown().optional(),
        }),
      ).safeParse(raw);
      if (!parsed.success) return { ok: false, failure: unexpected };
      const items = parsed.data.nodes.map((node) =>
        compact({
          id: idText(node.id),
          type: text(node.type),
          status: node.status ?? undefined,
          owner: idText(node.owner),
          created: isRecord(node.metadata)
            ? text(node.metadata.created, 40)
            : undefined,
        }),
      );
      return {
        ok: true,
        data: compact({
          totalCount: parsed.data.totalCount,
          orderedBy: ENTITIES_ORDER,
          statusNote: items.some((item) => item.status !== undefined)
            ? ENTITY_STATUS_NOTE
            : undefined,
          items,
        }),
      };
    }
    case 'entity': {
      if (raw === null) return { ok: false, failure: notFound('entity') };
      const parsed = z
        .looseObject({
          id: str,
          type: opt,
          status: z.number().nullish(),
          owner: opt,
          accounts: z.unknown().optional(),
          settings: z.unknown().optional(),
          linkedResource: z.unknown().optional(),
          linkedEntity: z.unknown().optional(),
          controller: z.unknown().optional(),
          service: z.unknown().optional(),
        })
        .safeParse(raw);
      if (!parsed.success) return { ok: false, failure: unexpected };
      const node = parsed.data;
      return {
        ok: true,
        ownedBy: accounts(node.owner),
        data: compact({
          id: idText(node.id),
          type: text(node.type),
          status: node.status ?? undefined,
          statusNote:
            node.status === null || node.status === undefined
              ? undefined
              : ENTITY_STATUS_NOTE,
          owner: idText(node.owner),
          controller: listOf(node.controller, (c) => text(c)),
          accounts: listOf(node.accounts, (a) =>
            isRecord(a)
              ? compact({
                  name: field(a, 'name'),
                  address: field(a, 'address'),
                })
              : undefined,
          ),
          linkedEntity: listOf(node.linkedEntity, (e) =>
            isRecord(e)
              ? compact({
                  id: field(e, 'id'),
                  type: field(e, 'type'),
                  relationship: field(e, 'relationship'),
                })
              : undefined,
          ),
          linkedResource: listOf(node.linkedResource, resourceOf),
          service: listOf(node.service, resourceOf),
          settings: isRecord(node.settings)
            ? Object.entries(node.settings)
                .slice(0, LIST_CAP)
                .map(([key, value]) => ({
                  key: clip(key, 80),
                  ...resourceOf(value),
                }))
            : undefined,
        }),
      };
    }
    case 'did_document': {
      if (raw === null) return { ok: false, failure: notFound('DID document') };
      const parsed = z
        .looseObject({
          id: str,
          controller: z.unknown().optional(),
          verificationMethod: z.unknown().optional(),
          linkedResource: z.unknown().optional(),
          alsoKnownAs: opt,
        })
        .safeParse(raw);
      if (!parsed.success) return { ok: false, failure: unexpected };
      const node = parsed.data;
      return {
        ok: true,
        data: compact({
          id: idText(node.id),
          controller: listOf(node.controller, (c) => text(c)),
          verificationMethod: listOf(node.verificationMethod, (m) =>
            isRecord(m)
              ? compact({
                  id: field(m, 'id'),
                  type: field(m, 'type'),
                  controller: field(m, 'controller'),
                  blockchainAccountID: field(m, 'blockchainAccountID'),
                  publicKeyMultibase: field(m, 'publicKeyMultibase'),
                  publicKeyBase58: field(m, 'publicKeyBase58'),
                })
              : undefined,
          ),
          linkedResource: listOf(node.linkedResource, resourceOf),
          alsoKnownAs: text(node.alsoKnownAs),
        }),
      };
    }
    case 'token_balances': {
      const parsed = connection(
        z.looseObject({
          tokenId: str,
          amount: z.union([z.string(), z.number()]),
          retired: num,
          token: z
            .looseObject({
              name: opt,
              collection: opt,
              tokenClassByName: z
                .looseObject({ contractAddress: opt, class: opt })
                .nullish(),
            })
            .nullish(),
        }),
      ).safeParse(raw);
      if (!parsed.success) return { ok: false, failure: unexpected };
      return {
        ok: true,
        data: compact({
          totalCount: parsed.data.totalCount,
          note: TOKEN_DECIMALS_NOTE,
          items: parsed.data.nodes.map((node) =>
            compact({
              tokenId: idText(node.tokenId),
              name: text(node.token?.name),
              class: idText(node.token?.tokenClassByName?.class),
              collection: idText(node.token?.collection),
              amount: amountText(node.amount),
              retired: idText(stringOf(node.retired)),
              contractAddress: idText(
                node.token?.tokenClassByName?.contractAddress,
              ),
            }),
          ),
        }),
      };
    }
    case 'transactions': {
      if (request.direction === 'received') {
        const parsed = z
          .looseObject({
            totalCount: z.number().optional(),
            nodes: z.array(
              messageNode.extend({
                transactionHash: str,
                transactionByTransactionHash: transactionNode.nullish(),
              }),
            ),
          })
          .safeParse(raw);
        if (!parsed.success) return { ok: false, failure: unexpected };
        // One row per transaction, holding the messages that matched.
        const rows = new Map<
          string,
          {
            node: z.infer<typeof transactionNode>;
            messages: z.infer<typeof messageNode>[];
          }
        >();
        for (const message of parsed.data.nodes) {
          const tx = message.transactionByTransactionHash;
          if (!tx) continue;
          const row = rows.get(message.transactionHash);
          if (row) row.messages.push(message);
          else
            rows.set(message.transactionHash, {
              node: tx,
              messages: [message],
            });
        }
        return {
          ok: true,
          data: compact({
            totalCount: parsed.data.totalCount,
            items: [...rows.values()].map((row) =>
              transactionOf(row.node, row.messages),
            ),
          }),
        };
      }
      const parsed = connection(
        z.looseObject({
          transactionHash: str,
          transaction: transactionNode.nullish(),
        }),
      ).safeParse(raw);
      if (!parsed.success) return { ok: false, failure: unexpected };
      // A transaction can list the same signer twice (a signature and a
      // fee grant): one row per transaction.
      const seen = new Set<string>();
      const items = parsed.data.nodes.flatMap((node) => {
        const tx = node.transaction;
        if (!tx || seen.has(tx.hash)) return [];
        seen.add(tx.hash);
        const messages = tx.messagesByTransactionHash;
        return [transactionOf(tx, messages?.nodes ?? [], messages?.totalCount)];
      });
      return {
        ok: true,
        data: compact({ totalCount: parsed.data.totalCount, items }),
      };
    }
    case 'transaction': {
      const parsed = z
        .looseObject({ nodes: z.array(transactionNode) })
        .safeParse(raw);
      if (!parsed.success) return { ok: false, failure: unexpected };
      const tx = parsed.data.nodes[0];
      if (!tx) return { ok: false, failure: notFound('transaction') };
      const messages = tx.messagesByTransactionHash;
      // A signer listed twice (a signature and a fee grant) is named once.
      const signers = [
        ...new Set(
          (tx.transactionSignersByTransactionId?.nodes ?? []).map(
            (signer) => signer.signerAddress,
          ),
        ),
      ];
      return {
        ok: true,
        ownedBy: signers,
        data: compact({
          ...transactionOf(tx, messages?.nodes ?? [], messages?.totalCount),
          signers: nonEmpty(
            signers.flatMap((signer) => {
              const shown = idText(signer);
              return shown ? [shown] : [];
            }),
          ),
          fee: isRecord(tx.fee) ? nonEmpty(coins(tx.fee.amount)) : undefined,
        }),
      };
    }
  }
}
