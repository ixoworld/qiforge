import {
  CHAIN_TX_CLAIM_ROLES,
  CHAIN_TX_COLLECTION_STATES,
  CHAIN_TX_DISPUTE_REASONS,
  CHAIN_TX_ENTITY_PERMISSIONS,
  CHAIN_TX_MAX_CLAIM_PERMISSION,
  CHAIN_TX_MAX_PAYMENT_COINS,
  CHAIN_TX_MAX_SECONDS,
  CHAIN_TX_MAX_TOKEN_LINES,
  CHAIN_TX_RESERVATION_MODES,
  CHAIN_TX_VOTE_OPTIONS,
  DENOM,
  type ChainTxMessageType,
} from '@ixo/action-protocol';
import { z } from 'zod';
import type { ChainTxMessageInput } from '../../plugin-api/types';

/**
 * The messages of one chain transaction (`ixo.chain.tx.v1`), as the model
 * writes them. The shapes are the protocol's minus the owner's identity
 * (`ChainTxOwnerField`: a claim's `agentDid`, an evaluation's
 * `agentAddress`, a permission's `creatorDid`, …), which the runtime fills,
 * as it fills the chain id, network and signer; a bank or stake step names
 * a display amount, which the owner object converts to base units. The
 * protocol parses the whole operation again before it reaches the Hub. The
 * rules match `@ixo/action-protocol`'s (ids, address length, DID escapes,
 * dates, links, text characters, cross-field rules), so a message the Hub
 * would refuse is refused here, before any Hub call, with the field named.
 */

/** A 20-byte bech32 account address: `ixo1` and 38 characters (a 32-byte contract address is longer). */
const IXO_ADDRESS = /^ixo1[023456789acdefghjklmnpqrstuvwxyz]{38}$/;
/** A validator operator address: `ixovaloper1` and 38 characters. */
const VALOPER_ADDRESS = /^ixovaloper1[023456789acdefghjklmnpqrstuvwxyz]{38}$/;
const BASE_UNITS = /^[1-9][0-9]{0,77}$/;
/** DID segments: `[A-Za-z0-9._-]` or a `%xx` escape, joined by `:` (the chain's x/iid rule). */
const DID_TAIL =
  '(?:(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})*:)*(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+';
const ANY_DID = new RegExp(`^did:[a-z0-9]+:${DID_TAIL}$`);
const IXO_DID = new RegExp(`^did:ixo:${DID_TAIL}$`);
const DID_MAX = 200;
/** x/entity ids: md5 hex of `<nftContract>/<sequence>`. */
const ENTITY_DID = /^did:ixo:entity:[0-9a-f]{32}$/;
/** Claim, collection, token and proof ids: no spaces, quotes or markup. */
const ID_CHARS = /^[A-Za-z0-9:._/-]+$/;
const ID_RULE = 'Only letters, digits and : . _ / - (copied exactly).';
/** A uint64 in decimal without leading zeros (bounded below). */
const UINT64_TEXT = /^(0|[1-9][0-9]{0,19})$/;
const UINT64_MAX = 18446744073709551615n;
/** RFC 3339 with `Z` or an offset, at most milliseconds. */
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/;
/** The latest instant a protobuf Timestamp holds the way the Hub encodes it. */
const INSTANT_MAX_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const CLAIM_COUNT = /^[1-9][0-9]{0,9}$/;
const JURISDICTION =
  /^(?:Global|[A-Z]{2}(?:-[A-Za-z0-9]{1,3}(?: [A-Za-z0-9]{1,64})?)?)$/;
const EVIDENCE_TYPE = /^[A-Za-z0-9][A-Za-z0-9.+/_-]{0,99}$/;
/** https: a host and no user info (`https://a@b` reads as `a` but goes to `b`). */
const HTTPS_URL = /^https:\/\/[^\s/?#@\\]+(?:[/?#][^\s\\]*)?$/;
const IPFS_URL = /^ipfs:\/\/[A-Za-z0-9]+(?:\/[^\s\\]*)?$/;
const URL_MAX = 300;
const ENTITY_TYPE = /^[a-z][a-z0-9_-]{0,31}(?:\/[a-z][a-z0-9_-]{0,31})?$/;
const ACCOUNT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,62}[A-Za-z0-9])?$/;
/**
 * x/iid item ids for an add: Portal writes `{id}#…` literally (the chain
 * stores it as is); the name after `#` may hold `:` (Portal's `#app:<id>`).
 */
const ITEM_ID =
  /^(?:\{id\}|did:ixo:[A-Za-z0-9._:%-]{1,160})#[A-Za-z0-9._~:-]{1,64}$/;
const ITEM_ID_MAX = 233;
/**
 * The id of an item to remove is whatever the record holds (Portal stored
 * `#api`, `{id}#ixo1…`, ids without `#`): 1..300 characters without
 * whitespace or unsafe characters. Auth Hub reads the record and refuses an
 * id that is not there.
 */
const REMOVE_ID_MAX = 300;
/** `+`: Portal's `application/vnd.ixo.design-pod+json` resource type. */
const IID_TYPE = /^[A-Za-z][A-Za-z0-9._:/+-]{0,63}$/;
const MEDIA_TYPE = /^[a-z]+\/[A-Za-z0-9.+-]{1,90}$/;
const MEDIA_TYPE_MAX = 128;
/** Mixed case: Portal writes `Governs`. */
const RELATIONSHIP = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CONTEXT_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/**
 * A linked entity's service: `""` (none, Portal's default), a service name
 * (`svc1`, `matrix`, `did:cosmos:ixo` as stored on chain) or a reference to
 * one (`{id}#matrix`).
 */
const SERVICE_REF =
  /^(?:(?:(?:\{id\}|did:ixo:[A-Za-z0-9._:%-]{1,160})#)?[A-Za-z0-9._~:-]{1,64})?$/;
/**
 * A linked entity that is not a DID: an ixo account (20-byte) or contract
 * (32-byte) address, or Portal's `{id}#<address>` (a group's core contract).
 */
const LINKED_ENTITY_ADDRESS =
  /^(?:\{id\}#)?ixo1(?:[023456789acdefghjklmnpqrstuvwxyz]{38}|[023456789acdefghjklmnpqrstuvwxyz]{58})$/;

/**
 * Characters that would let text render as something else: C0 and C1
 * controls, zero-width and direction marks (U+200B–U+200F), line and
 * paragraph separators (U+2028–U+2029), bidi embeddings, overrides and
 * isolates (U+202A–U+202E, U+2066–U+2069), the Arabic letter mark (U+061C)
 * and the byte order mark (U+FEFF). Auth Hub refuses the same set.
 */
export function hasUnsafeText(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    )
      return true;
  }
  return false;
}

/**
 * The epoch milliseconds of an RFC 3339 instant that is a real calendar
 * date and, in UTC, between 1970-01-01T00:00:00Z and the end of 9999 (what
 * a protobuf Timestamp holds the way the Hub encodes it); else null.
 */
export function instantMs(value: string): number | null {
  const parts = INSTANT.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    parts;
  const y = Number(year);
  const m = Number(month);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    m < 1 ||
    m > 12 ||
    Number(day) < 1 ||
    Number(day) > (days[m - 1] ?? 0) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (offsetHour !== undefined &&
      (Number(offsetHour) > 23 || Number(offsetMinute) > 59))
  )
    return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= 0 && ms <= INSTANT_MAX_MS ? ms : null;
}

/** An https:// link (and an ipfs:// one when allowed) of at most 300 characters. */
function isLink(value: string, ipfs: boolean): boolean {
  if (value.length > URL_MAX || hasUnsafeText(value)) return false;
  if (ipfs && IPFS_URL.test(value)) return true;
  if (!HTTPS_URL.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

// ---- Field builders (the formats describe_chain_messages shows) ----

const address = (what: string) =>
  z
    .string()
    .regex(
      IXO_ADDRESS,
      'A 20-byte ixo1… account address (42 characters); contract addresses are refused.',
    )
    .describe(`${what} (an ixo1… account address).`);
const validator = (what: string) =>
  z
    .string()
    .regex(
      VALOPER_ADDRESS,
      'An ixovaloper1… validator address (49 characters), copied exactly from chain_lookup staking.',
    )
    .describe(`${what} (an ixovaloper1… validator address).`);
const id = (max: number) => z.string().min(1).max(max).regex(ID_CHARS, ID_RULE);
const baseUnits = (what: string) =>
  z
    .string()
    .regex(BASE_UNITS, 'A whole number of base units above zero.')
    .describe(what);
const uint64 = (what: string) =>
  z
    .string()
    .regex(UINT64_TEXT, 'Digits only, no leading zeros.')
    // zod runs every check: a value the pattern refused is not parsed here.
    .refine(
      (value) => !UINT64_TEXT.test(value) || BigInt(value) <= UINT64_MAX,
      {
        message: 'At most 18446744073709551615.',
      },
    )
    .describe(what);
const ixoDid = (what: string) =>
  z
    .string()
    .max(DID_MAX)
    .regex(IXO_DID, 'A did:ixo:… DID (% only as %xx), copied exactly.')
    .describe(what);
const entityDid = (what: string) =>
  z
    .string()
    .regex(
      ENTITY_DID,
      'did:ixo:entity: and 32 lowercase hex characters, copied exactly.',
    )
    .describe(what);
const instant = (what: string) =>
  z
    .string()
    .max(40)
    .regex(
      INSTANT,
      'A date and time in RFC 3339 with Z or an offset, such as 2026-11-01T00:00:00Z or 2026-12-31T23:59:59+03:00.',
    )
    .refine((value) => instantMs(value) !== null, {
      message: 'A real calendar date between 1970 and the end of 9999.',
    })
    .describe(what);
const plainText = (max: number, what: string) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !hasUnsafeText(value) && /\S/.test(value), {
      message:
        'Plain text: not blank, no control, invisible or text-direction characters.',
    })
    .describe(what);
const link = (ipfs: boolean, what: string) =>
  z
    .string()
    .min(1)
    .max(URL_MAX)
    .refine((value) => isLink(value, ipfs), {
      message: ipfs
        ? 'An https:// link with a host (no user@, spaces or backslashes) or an ipfs://<CID> link, at most 300 characters.'
        : 'An https:// link with a host (no user@, spaces or backslashes), at most 300 characters.',
    })
    .describe(what);
const claimCount = (what: string) =>
  z
    .string()
    .regex(CLAIM_COUNT, 'Digits, 1 to 1000000000.')
    .refine((value) => Number(value) <= CHAIN_TX_MAX_CLAIM_PERMISSION, {
      message: 'At most 1000000000.',
    })
    .describe(what);
const seconds = (what: string) =>
  z.number().int().min(0).max(CHAIN_TX_MAX_SECONDS).describe(what);
const proof = id(300).describe(
  'The content id (CID) or proof of the stored document, copied exactly.',
);
const claimId = id(256).describe('The claim id, exactly as stored.');
const collectionId = uint64('The claim collection id (digits).');
const adminAddress = address(
  "The collection's admin account (chain_lookup claim_collection: `admin`)",
);
const itemId = (what: string) =>
  z
    .string()
    .max(ITEM_ID_MAX)
    .regex(
      ITEM_ID,
      '`{id}#name` or `did:ixo:…#name` (name: letters, digits and . _ ~ : -).',
    )
    .describe(what);
const removeId = (what: string) =>
  z
    .string()
    .min(1)
    .max(REMOVE_ID_MAX)
    .refine((value) => !/\s/.test(value) && !hasUnsafeText(value), {
      message:
        'The id exactly as the record shows it: no spaces, control, invisible or text-direction characters.',
    })
    .describe(what);
/** A linked resource's or claim's proof: "" (app links) or a content id. */
const linkProof = z
  .string()
  .max(300)
  .refine((value) => value === '' || ID_CHARS.test(value), { message: ID_RULE })
  .describe(
    'The stored document’s content id (CID), copied exactly; "" when it has none.',
  );
/** A linked resource's or claim's description: up to 300, "" allowed. */
const linkDescription = (what: string) =>
  z
    .string()
    .max(300)
    .refine((value) => !hasUnsafeText(value), {
      message: 'No control, invisible or text-direction characters.',
    })
    .describe(what);
const linkRight = z
  .string()
  .max(300)
  .refine(
    (value) => value === '' || (!hasUnsafeText(value) && /\S/.test(value)),
    {
      message:
        'Plain text: not blank, no control, invisible or text-direction characters.',
    },
  )
  .optional()
  .describe('Optional: the rights that apply to it.');
const iidType = (what: string) =>
  z
    .string()
    .max(64)
    .regex(
      IID_TYPE,
      'Starts with a letter; letters, digits and . _ : / + - (up to 64).',
    )
    .describe(what);
/** A display amount: a plain decimal in the token's units, as the user said it. */
const DISPLAY_AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const ixoAmount = z
  .string()
  .max(80)
  .regex(
    DISPLAY_AMOUNT,
    'A plain decimal amount of IXO, such as 100 or 0.5 (never base units).',
  )
  .describe('The amount of IXO as the owner said it (100 = 100 IXO).');

/** Payment coins of one leg: base units, each token once. */
const paymentCoins = z
  .array(
    z.strictObject({
      denom: z
        .string()
        .max(128)
        .regex(DENOM, 'A denom, copied exactly (uixo for IXO).')
        .describe('The token: `uixo` for IXO, else its denom copied exactly.'),
      amountBaseUnits: baseUnits(
        'The amount in base units (1 IXO = 1000000 uixo).',
      ),
    }),
  )
  .max(CHAIN_TX_MAX_PAYMENT_COINS)
  .superRefine((coins, ctx) => {
    const seen = new Set<string>();
    coins.forEach((coin, index) => {
      if (seen.has(coin.denom))
        ctx.addIssue({
          code: 'custom',
          path: [index, 'denom'],
          message: 'Each token once per payment.',
        });
      seen.add(coin.denom);
    });
  })
  .describe('Up to 4 coins, each token once; an empty list pays nothing.');
const payAfterSeconds = seconds(
  'Optional: the payment can be collected only this many seconds later (0 or absent: paid at once).',
).optional();
const paymentLeg = (what: string) =>
  z
    .strictObject({ amount: paymentCoins, payAfterSeconds })
    .optional()
    .describe(what);
const payments = z
  .strictObject({
    submission: paymentLeg('Paid to the filer when a claim is filed.'),
    evaluation: paymentLeg('Paid to the checker for each check.'),
    approval: z
      .strictObject({
        amount: paymentCoins,
        payAfterSeconds,
        networkSplit: z
          .boolean()
          .optional()
          .describe(
            'true: the payment is shared with the network and the oracle.',
          ),
      })
      .optional()
      .describe('Paid to the filer when a claim is approved.'),
    rejection: paymentLeg('Paid to the filer when a claim is rejected.'),
  })
  .describe('What the collection pays; a leg left out pays nothing.');

/** Refuses an end at or before a given start, on `endDate` (the protocol's rule). */
function endAfterStart(
  dates: { startDate?: string; endDate?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (typeof dates.startDate !== 'string' || typeof dates.endDate !== 'string')
    return;
  const start = instantMs(dates.startDate);
  const end = instantMs(dates.endDate);
  if (start !== null && end !== null && end <= start)
    ctx.addIssue({
      code: 'custom',
      path: ['endDate'],
      message: 'The end must be after the start.',
    });
}

/** At least one of the dates; the protocol names `startDate` when neither is given. */
function someDate(
  dates: { startDate?: string; endDate?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (dates.startDate === undefined && dates.endDate === undefined)
    ctx.addIssue({
      code: 'custom',
      path: ['startDate'],
      message: 'Give startDate, endDate or both.',
    });
}

/**
 * The claim-permission options of a role: `reservationSeconds` only for
 * `file-claims`, `decideBefore` only for `check-claims`.
 */
function roleOptions(
  message: {
    reservationSeconds?: number;
    decideBefore?: string;
  },
  role: string,
  ctx: z.RefinementCtx,
): void {
  if (message.reservationSeconds !== undefined && role !== 'file-claims')
    ctx.addIssue({
      code: 'custom',
      path: ['reservationSeconds'],
      message: 'Only for file-claims.',
    });
  if (message.decideBefore !== undefined && role !== 'check-claims')
    ctx.addIssue({
      code: 'custom',
      path: ['decideBefore'],
      message: 'Only for check-claims.',
    });
}

/**
 * One chain-transaction message type: the one-line `summary` the request
 * tool's description lists, the full `rules` describe_chain_messages
 * returns (with the fields of `schema`), and the strict `schema` the
 * request handler checks each message against. Adding a message type is
 * one entry here (once `@ixo/action-protocol` and Auth Hub support it).
 */
export interface ChainTxCatalogEntry {
  summary: string;
  rules: string;
  schema: z.ZodObject;
}

/** Said once for the ten identity-record types. */
const IID_RULES =
  'Changes the public identity record (`did`) of an entity the owner controls, or the owner’s own record (`did:ixo:` and their ixo1… address). Read the record first with chain_lookup did_document (or entity) to see what is there. The owner’s key must be one of the record’s sign-in keys, which is the case for their own record and for entities they created.';
const IID_ADD_RULE =
  'A new item’s id is `{id}#name` (Portal’s form; `{id}` stands for the record) or `did:ixo:…#name`.';
const IID_REMOVE_RULE =
  'Copy the id exactly as the lookup shows it, whatever its form (`#api`, `{id}#ixo1…`): Auth Hub checks it is there before it makes the card.';

/**
 * The catalogue. Every `rules` text ends with how to say the step to the
 * owner: plain everyday words, never the message type or chain terms (the
 * review card in Auth Hub shows the exact values).
 */
export const CHAIN_TX_CATALOG = {
  'cosmos.bank.send': {
    summary:
      "send coins (IXO or another token the owner holds) from the owner's wallet.",
    rules: [
      "Sends coins from the owner's wallet to `toAddress`, alone (a single coin send) or as a step of a batch.",
      '`amount` is the amount as the user said it, in the token’s display units ("1.5" for 1.5 IXO): a plain decimal, never base units. The runtime looks the token up in the owner’s token list (hub_action_options `transfer.tokens`), converts the amount with the listed `decimals`, and refuses a token not in the list, more digits after the point than the token has, zero, and more than the listed balance (the bank and stake steps of one token together).',
      '`denom` is optional and defaults to uixo (IXO, 6 decimals). For another token copy its `denom` exactly from `transfer.tokens` (never guess an `ibc/…` hash); name the full denom to the owner for anything but IXO, and say when the token is unverified (it lists 0 decimals: its amount is a whole number of base units).',
      'Say it like: “Send 1.5 IXO to Thandi (ixo1qy…lvf0).”',
    ].join(' '),
    schema: z.strictObject({
      type: z.literal('cosmos.bank.send'),
      toAddress: address('The recipient'),
      amount: z
        .string()
        .max(80)
        .regex(
          DISPLAY_AMOUNT,
          'A plain decimal amount in the token’s display units, such as 1.5 (never base units).',
        )
        .describe(
          'The amount as the user said it, in the token’s display units (1.5 = 1.5 IXO).',
        ),
      denom: z
        .string()
        .regex(DENOM, 'A denom exactly as hub_action_options lists it.')
        .optional()
        .describe(
          'The token’s denom, copied exactly from hub_action_options `transfer.tokens`; leave out for uixo (IXO).',
        ),
    }),
  },
  'ixo.claims.submit': {
    summary:
      'file a claim the owner has already created with a claim collection.',
    rules:
      'Files a claim the owner has already created with a claim collection. `claimId` is the stored claim’s id, `collectionId` the collection, `adminAddress` the collection admin’s address. The runtime adds the owner’s DID as the filer. The collection admin must have authorized the owner to submit claims. Collections with member budgets cannot be filed into here (no member address is sent). Set `useIntent` only when the collection works with intents (after an `ixo.claims.claim-intent` reservation). Say it like: “File your claim in the Clean Water collection.”',
    schema: z.strictObject({
      type: z.literal('ixo.claims.submit'),
      collectionId,
      claimId,
      adminAddress: address("The collection admin's address"),
      useIntent: z
        .boolean()
        .optional()
        .describe('true only when the collection pays claims through intents.'),
    }),
  },
  'ixo.claims.evaluate': {
    summary:
      'record the owner’s decision, as evaluator, on someone else’s claim (approve, reject, dispute, invalidate).',
    rules:
      'Records the owner’s decision, as evaluator, on someone else’s claim (`claimId` in `collectionId`). `status` 1 approve, 2 reject, 3 dispute (the chain may refuse it as deprecated), 4 invalidate. It is recorded as the owner’s (the runtime adds their DID and address, never the claimant’s); `oracle` is the evaluator DID recorded on the evaluation (normally the owner’s DID, or the oracle entity DID the collection admin authorized); `adminAddress` is the collection admin’s address; `reason` (a number) and `verificationProof` are optional. The collection admin must have authorized the owner as an evaluator. An approval can pay the claimant. Say it like: “Approve this claim in Clean Water; approving it can release its payment.”',
    schema: z.strictObject({
      type: z.literal('ixo.claims.evaluate'),
      claimId,
      collectionId,
      oracle: z
        .string()
        .max(DID_MAX)
        .regex(ANY_DID, 'A DID (did:<method>:…; % only as %xx).')
        .describe('The evaluator DID recorded on the evaluation (a did:…).'),
      adminAddress: address("The collection admin's address"),
      status: z
        .literal([1, 2, 3, 4])
        .describe(
          '1 approve, 2 reject, 3 dispute (the chain may refuse it as deprecated), 4 invalidate.',
        ),
      reason: z
        .number()
        .int()
        .min(0)
        .max(4_294_967_295)
        .optional()
        .describe("The evaluator's reason code, when there is one."),
      verificationProof: id(300)
        .optional()
        .describe(
          'The evaluation proof (a credential CID), when there is one.',
        ),
    }),
  },
  'ixo.token.transfer': {
    summary:
      "move IXO impact tokens (1155-style token ids, whole amounts) from the owner's wallet.",
    rules: `Moves IXO impact tokens (1155-style: each line a token \`id\` of 32 hex characters and a whole \`amount\`, 1 to ${CHAIN_TX_MAX_TOKEN_LINES} lines) from the owner’s wallet to \`recipient\`. Impact tokens have no decimals: an amount is a whole number of tokens. All tokens in one message must come from one token contract. These are not the IXO coin: coins go through \`cosmos.bank.send\`. Say it like: “Give 3 of your carbon credits to Thandi (ixo1qy…lvf0).”`,
    schema: z.strictObject({
      type: z.literal('ixo.token.transfer'),
      recipient: address('The recipient'),
      tokens: z
        .array(
          z.strictObject({
            id: id(128).describe(
              'The impact token id (32 hex characters), exactly as listed.',
            ),
            amount: baseUnits('A whole number of tokens above zero.'),
          }),
        )
        .min(1)
        .max(CHAIN_TX_MAX_TOKEN_LINES),
    }),
  },
  'ixo.token.retire': {
    summary:
      'use up (retire) impact tokens the owner holds, for good, for example to offset emissions.',
    rules: `Uses up impact tokens the owner holds, for good: retired tokens can never be sold, moved or used again, and nothing undoes it. Never retire without the owner clearly asking for it. Ask which tokens and how many, where it counts (\`jurisdiction\`: a two-letter country code such as \`KE\`, optionally with a region and postal code such as \`KE-30\` or \`ZA-WC 7700\`, or \`Global\` for everywhere) and why, in their words (\`reason\`, up to 200 characters, for example \`offset\`). Find the token ids with chain_lookup token_balances: each line is a token \`id\` and a whole \`amount\` (impact tokens have no decimals), 1 to ${CHAIN_TX_MAX_TOKEN_LINES} lines, all of one kind of token. Say it like: “Retire 10 of your carbon credits for good, to offset your 2026 travel. This can’t be undone.”`,
    schema: z.strictObject({
      type: z.literal('ixo.token.retire'),
      tokens: z
        .array(
          z.strictObject({
            id: id(128).describe('The impact token id, exactly as listed.'),
            amount: baseUnits('A whole number of tokens above zero.'),
          }),
        )
        .min(1)
        .max(CHAIN_TX_MAX_TOKEN_LINES),
      jurisdiction: z
        .string()
        .max(71)
        .regex(
          JURISDICTION,
          'Global, or a two-letter country code with an optional region and postal code (KE, KE-30, ZA-WC 7700).',
        )
        .describe('Where the retirement counts: a country code or Global.'),
      reason: plainText(200, 'Why, in the owner’s words (e.g. offset).'),
    }),
  },
  'cosmos.staking.delegate': {
    summary: "stake the owner's IXO with a validator so it earns rewards.",
    rules:
      'Stakes IXO from the owner’s wallet with a validator (one of the operators that run the network) so it earns rewards; the IXO stays theirs. `amount` is IXO as the owner says it ("100", "0.5"), never base units: the runtime converts it and checks it against their IXO balance. Ask how much and with which validator; find validator addresses (`validatorAddress`) and names with chain_lookup staking, or ask the owner. Getting staked IXO back takes the unbonding period (21 days on IXO today; the review card shows the exact time), so never stake all of it: leave some IXO for fees. Staking with a validator also pays out the rewards already earned with it. Say it like: “Stake 100 IXO with Alex’s validator. It keeps earning rewards, and getting it back takes about 21 days.”',
    schema: z.strictObject({
      type: z.literal('cosmos.staking.delegate'),
      validatorAddress: validator('The validator to stake with'),
      amount: ixoAmount,
    }),
  },
  'cosmos.staking.undelegate': {
    summary:
      'unstake IXO from a validator; it comes back to the wallet after the unbonding period.',
    rules:
      'Stops staking IXO with a validator. It comes back to the owner’s wallet after the unbonding period (21 days on IXO today) and earns nothing in between. See what they have staked, and with whom, with chain_lookup staking (copy `validatorAddress` from there); ask how much (`amount` in IXO as the owner says it, never base units and never more than they have staked there). Rewards waiting with that validator are paid out at the same time. At most 7 unstakes per validator can be waiting at once. Say it like: “Unstake 50 IXO from Alex’s validator. It’s back in your wallet in about 21 days and earns nothing until then.”',
    schema: z.strictObject({
      type: z.literal('cosmos.staking.undelegate'),
      validatorAddress: validator('The validator to unstake from'),
      amount: ixoAmount,
    }),
  },
  'cosmos.staking.redelegate': {
    summary:
      'move staked IXO from one validator to another, right away and without waiting.',
    rules:
      'Moves IXO the owner has staked from one validator (`fromValidatorAddress`) to another (`toValidatorAddress`, a different one) at once; it keeps earning rewards and nothing passes through the wallet. Use chain_lookup staking for what they have staked and with whom; ask how much (`amount` in IXO as the owner says it, never more than they have staked with the first validator) and with whom it should go. Stake moved this way can’t be moved again for the unbonding period (21 days on IXO today). Rewards waiting with both validators are paid out. Say it like: “Move 50 IXO of your stake from Alex’s validator to Bo’s. It keeps earning rewards; you can’t move it again for about 21 days.”',
    schema: z
      .strictObject({
        type: z.literal('cosmos.staking.redelegate'),
        fromValidatorAddress: validator('The validator the stake is with now'),
        toValidatorAddress: validator('The validator it moves to'),
        amount: ixoAmount,
      })
      .superRefine((message, ctx) => {
        if (message.toValidatorAddress === message.fromValidatorAddress)
          ctx.addIssue({
            code: 'custom',
            path: ['toValidatorAddress'],
            message: 'A different validator than fromValidatorAddress.',
          });
      }),
  },
  'cosmos.distribution.withdraw-rewards': {
    summary:
      'claim the staking rewards the owner has earned with a validator (one message per validator).',
    rules:
      'Moves the rewards the owner earned by staking with one validator into their wallet (or to the account they set to receive their rewards). One message per validator, up to 8 in one card: use chain_lookup staking to see which validators have rewards and leave out those with none (Auth Hub refuses a validator with nothing to claim). Staking, unstaking or moving stake with a validator already pays its rewards out. Say it like: “Claim about 12.5 IXO of staking rewards from Alex’s validator.”',
    schema: z.strictObject({
      type: z.literal('cosmos.distribution.withdraw-rewards'),
      validatorAddress: validator('The validator the rewards were earned with'),
    }),
  },
  'cosmos.gov.vote': {
    summary:
      'vote yes, no, abstain or no-with-veto on a network proposal that is open for voting.',
    rules:
      'Records the owner’s vote on a network proposal that is open for voting. Find open proposals, their number (`proposalId`) and title with chain_lookup gov_proposals, and tell the owner the title and when voting closes before asking how they vote. `option`: `yes`, `no`, `abstain` (counts toward the turnout without taking a side) or `no_with_veto` (no, and they think it should never have been proposed). Only IXO they have staked gives the vote weight. Voting again before it closes replaces this vote. Say it like: “Vote Yes on proposal 506, ‘Lower the fees’. You can change your vote until 31 October.”',
    schema: z.strictObject({
      type: z.literal('cosmos.gov.vote'),
      proposalId: z
        .string()
        .regex(/^[1-9][0-9]{0,19}$/, 'The proposal number: digits, from 1.')
        .refine(
          (value) => !UINT64_TEXT.test(value) || BigInt(value) <= UINT64_MAX,
          {
            message: 'At most 18446744073709551615.',
          },
        )
        .describe('The proposal number (chain_lookup gov_proposals).'),
      option: z
        .literal([...CHAIN_TX_VOTE_OPTIONS])
        .describe('yes, no, abstain or no_with_veto.'),
    }),
  },
  'ixo.claims.claim-intent': {
    summary:
      "reserve a collection's payment before filing a claim in it (only where reservations are used).",
    rules:
      'Sets aside a claim collection’s payment for a claim the owner is about to file, for a limited time; nothing leaves their wallet. Use it only when the collection allows or requires reservations (chain_lookup claim_collection) and the owner is already allowed to file claims there; they can hold one reservation per collection. Afterwards file the claim with `ixo.claims.submit` and `useIntent: true` before the reservation runs out. The runtime adds the owner as the filer. Say it like: “Reserve the payment in the Clean Water collection for the claim you’re about to file.”',
    schema: z.strictObject({
      type: z.literal('ixo.claims.claim-intent'),
      collectionId,
    }),
  },
  'ixo.claims.dispute': {
    summary:
      'open a dispute about a claim (the work, or how it was checked); it may take a deposit.',
    rules:
      'Opens a dispute about a claim, decided by someone independent. Ask what is wrong: `reason` `not_as_asked` (the work isn’t what was asked for), `not_delivered` (nothing was delivered), `check_wrong` (the check of the claim got it wrong) or `other`. `claimId` and `collectionId` come from chain_lookup claim or claims (Auth Hub checks they belong together). `evidence` is the owner’s statement, which must ALREADY be stored: its link (`uri`, https:// or ipfs://), its kind (`type`, for example `eval-engine/v1`), its `proof` (content id) and whether it is `encrypted`. There is no tool here that stores a statement: when the owner has none stored, tell them it has to be saved first (for example in Portal) and do not prepare the card. The collection may take a deposit, returned if they are proven right and lost if not: say so. Until it is decided, the person disputed can’t file or check claims in that collection. Never dispute for someone else; the runtime adds the owner as the one disputing. Say it like: “Dispute this claim in Clean Water because the work isn’t what was asked for. A deposit may apply: you get it back if you’re proven right.”',
    schema: z.strictObject({
      type: z.literal('ixo.claims.dispute'),
      claimId,
      collectionId,
      reason: z
        .literal([...CHAIN_TX_DISPUTE_REASONS])
        .describe('not_as_asked, not_delivered, check_wrong or other.'),
      evidence: z
        .strictObject({
          uri: link(true, 'Where the stored statement is.'),
          type: z
            .string()
            .max(100)
            .regex(
              EVIDENCE_TYPE,
              'Letters, digits and . + / _ - (up to 100), such as eval-engine/v1.',
            )
            .describe('The kind of statement, such as eval-engine/v1.'),
          proof,
          encrypted: z
            .boolean()
            .optional()
            .describe('true when the stored statement is encrypted.'),
        })
        .describe('The already stored statement.'),
    }),
  },
  'ixo.claims.update-collection-state': {
    summary: 'open, pause or close a claim collection the owner manages.',
    rules:
      'Opens, pauses or closes a claim collection. It works with a permission the collection’s entity gave the owner’s address (chain_lookup authz_grants, received, from the collection’s admin account); the entity’s owner gives it with `ixo.entity.grant-account-authz` (`change-collection-state`). `adminAddress` is the collection’s admin account (chain_lookup claim_collection). `state`: `open` (claims can be filed), `paused` or `closed` (both stop new claims; claims already filed can still be checked, and it can be opened again). Ask which. Say it like: “Pause the Clean Water collection so no new claims come in until you open it again.”',
    schema: z.strictObject({
      type: z.literal('ixo.claims.update-collection-state'),
      collectionId,
      adminAddress,
      state: z
        .literal([...CHAIN_TX_COLLECTION_STATES])
        .describe('open, paused or closed.'),
    }),
  },
  'ixo.claims.update-collection-dates': {
    summary: 'change when a claim collection opens and closes.',
    rules:
      'Changes when a claim collection takes claims, with the same kind of permission and `adminAddress` as `ixo.claims.update-collection-state` (permission `change-collection-dates`). Give only the date that changes: `startDate` and/or `endDate`; `endDate: null` removes the end date; a date left out stays as it is. The end must be after the start. Convert the owner’s dates from their time zone (2026-12-31T23:59:59+03:00). Say it like: “Keep the Clean Water collection open until 31 December 2026.”',
    schema: z
      .strictObject({
        type: z.literal('ixo.claims.update-collection-dates'),
        collectionId,
        adminAddress,
        startDate: instant('When it opens; leave out to keep it.').optional(),
        endDate: instant(
          'When it closes; null: no end date; leave out to keep it.',
        )
          .nullable()
          .optional(),
      })
      .superRefine((message, ctx) => {
        someDate(message, ctx);
        endAfterStart(message, ctx);
      }),
  },
  'ixo.claims.update-collection-quota': {
    summary: 'change how many claims a collection takes in total.',
    rules:
      'Sets how many claims a collection takes in total (`maxClaims`, digits; "0" = no limit), with the same kind of permission and `adminAddress` as `ixo.claims.update-collection-state` (permission `change-collection-quota`). It can’t be below the number already filed (chain_lookup claim_collection shows it); setting it equal stops new claims. Say it like: “Let the Clean Water collection take up to 500 claims in total (120 so far).”',
    schema: z.strictObject({
      type: z.literal('ixo.claims.update-collection-quota'),
      collectionId,
      adminAddress,
      maxClaims: uint64('The total number of claims; "0" = no limit.'),
    }),
  },
  'ixo.claims.create-claim-authorization': {
    summary:
      'let another account file or check claims in a collection the owner manages with a permission from its entity.',
    rules:
      'Lets an account (`granteeAddress`) file claims in (`role: file-claims`) or check claims of (`role: check-claims`) one collection, up to `maxClaims` claims (1 to 1000000000). It is for people who manage a collection with a permission from its entity (`authorize-claim-agents`, chain_lookup authz_grants received); when the owner owns the entity, use `ixo.entity.grant-account-authz` instead. `adminAddress` is the collection’s admin account (chain_lookup claim_collection). Ask who, which role, how many claims and until when (`expiresAt`; left out, an end date the account already has for this kind of permission is kept, else it has none). Optional: `reservationSeconds` (file-claims only: how long a reservation holds the payment) and `decideBefore` (check-claims only: the date checks must be done by). Never pick a role the owner did not name. The runtime adds the owner as the one who gives it. Say it like: “Let Thandi (ixo1qy…lvf0) file up to 50 claims in the Clean Water collection until 31 December.”',
    schema: z
      .strictObject({
        type: z.literal('ixo.claims.create-claim-authorization'),
        collectionId,
        adminAddress,
        granteeAddress: address('Who gets the permission'),
        role: z
          .literal([...CHAIN_TX_CLAIM_ROLES])
          .describe('file-claims or check-claims.'),
        maxClaims: claimCount('How many claims, 1 to 1000000000.'),
        expiresAt: instant('Optional: when the permission ends.').optional(),
        reservationSeconds: seconds(
          'file-claims only: how long a reservation holds the payment, in seconds.',
        ).optional(),
        decideBefore: instant(
          'check-claims only: the date checks must be done by.',
        ).optional(),
      })
      .superRefine((message, ctx) => roleOptions(message, message.role, ctx)),
  },
  'ixo.claims.update-collection-payments': {
    summary:
      'change what a collection pays when claims are filed, checked, approved or rejected.',
    rules:
      'Replaces what a claim collection pays, with the same kind of permission and `adminAddress` as `ixo.claims.update-collection-state` (permission `change-collection-payments`). Read the current payments first with chain_lookup claim_collection and send the whole new set: a leg left out pays nothing. Legs: `submission` (to the filer when a claim is filed), `evaluation` (to the checker for each check), `approval` (to the filer when approved; `networkSplit: true` shares it with the network and the oracle) and `rejection` (to the filer when rejected). Each leg has `amount`, up to 4 coins of different tokens, each `{denom, amountBaseUnits}` in base units (IXO: denom `uixo`, 1 IXO = 1000000; another token’s denom copied exactly from a lookup, never a guessed `ibc/…` denom), and optional `payAfterSeconds` (up to 31536000: it can be collected only that much later). Collections that pay in contract tokens can’t be changed here. Say it like: “Pay 50 IXO for each approved claim in the Clean Water collection, and nothing for filing or rejected claims.”',
    schema: z.strictObject({
      type: z.literal('ixo.claims.update-collection-payments'),
      collectionId,
      adminAddress,
      payments,
    }),
  },
  'ixo.claims.create-collection': {
    summary: 'create a claim collection for an entity the owner owns.',
    rules:
      'Creates a claim collection: a place where people file claims of one kind for an entity the owner owns. Ask for the entity (`entityId`: chain_lookup entities or entity), the kind of claim (`protocolId`, the claim template’s did:ixo DID), when it opens (`startDate`) and closes (`endDate`, or null for no end date; always give the key), how many claims in total (`maxClaims`, "0" = no limit), how it starts (`state`: open, paused or closed), whether claims are reserved first (`reservations`: `allow`, `deny` or `required`) and what it pays (`payments`, as for `ixo.claims.update-collection-payments`, in base units). To manage it from chat later, add `ixo.entity.grant-account-authz` steps to the same card that give the owner’s own address `change-collection-state`, `change-collection-dates`, `change-collection-quota` and `change-collection-payments` (as Portal does). A collection can’t be deleted, only closed. The result does not include the new collection’s number: once the owner has approved it and it went through (hub_action_status), find it with chain_lookup claim_collections. Say it like: “Create a claim collection for Clean Water Project, open from 1 November with no end date, paying 50 IXO for each approved claim.”',
    schema: z
      .strictObject({
        type: z.literal('ixo.claims.create-collection'),
        entityId: entityDid('The entity the collection belongs to.'),
        protocolId: ixoDid('The kind of claim: the claim template’s DID.'),
        startDate: instant('When it opens.'),
        endDate: instant('When it closes; null: no end date.').nullable(),
        maxClaims: uint64('The total number of claims; "0" = no limit.'),
        state: z
          .literal([...CHAIN_TX_COLLECTION_STATES])
          .describe('How it starts: open, paused or closed.'),
        reservations: z
          .literal([...CHAIN_TX_RESERVATION_MODES])
          .describe('allow, deny or required.'),
        payments,
      })
      .superRefine(endAfterStart),
  },
  'ixo.entity.create-account': {
    summary: 'add a named account (for funds) to an entity the owner owns.',
    rules:
      'Adds a new, empty account with a name to an entity the owner owns (`entityId`: chain_lookup entities or entity, which also lists the entity’s accounts; a name already used is refused). `name`: letters, digits, spaces, `_` or `-`, up to 64 characters, not `admin`. It can’t be removed later. Say it like: “Add an account called ‘Payouts’ to Clean Water Project.”',
    schema: z.strictObject({
      type: z.literal('ixo.entity.create-account'),
      entityId: entityDid('The entity.'),
      name: z
        .string()
        .max(64)
        .regex(
          ACCOUNT_NAME,
          'Letters, digits, spaces, _ or - (starting and ending with a letter or digit), up to 64.',
        )
        .refine((value) => value.toLowerCase() !== 'admin', {
          message: 'Not admin (every entity already has it).',
        })
        .describe('The new account’s name.'),
    }),
  },
  'ixo.entity.update': {
    summary:
      'change when an entity the owner controls is active (its start and end dates).',
    rules:
      'Changes an entity’s start and/or end date (`startDate`, `endDate`; `endDate: null` clears it); a date left out stays as it is, and so do its status and credentials. The end must be after the start. The owner must control the entity (chain_lookup entity); the runtime adds the owner as the controller. Say it like: “Set Clean Water Project to run until 31 December 2030.”',
    schema: z
      .strictObject({
        type: z.literal('ixo.entity.update'),
        entityId: entityDid('The entity.'),
        startDate: instant('When it starts; leave out to keep it.').optional(),
        endDate: instant('When it ends; null clears it; leave out to keep it.')
          .nullable()
          .optional(),
      })
      .superRefine((message, ctx) => {
        someDate(message, ctx);
        endAfterStart(message, ctx);
      }),
  },
  'ixo.entity.revoke-account-authz': {
    summary: "remove a permission the owner's entity gave another account.",
    rules:
      'Removes one kind of permission (`permission`, as listed for `ixo.entity.grant-account-authz`) that an entity the owner owns (`entityId`) gave an account (`granteeAddress`). See what the entity gave with chain_lookup authz_grants (given, for the entity’s admin account; chain_lookup entity lists its accounts). It removes the whole permission, for every collection it covers: to remove one collection only, add an `ixo.entity.grant-account-authz` step after it that gives the rest back. Say it like: “Stop Thandi (ixo1qy…lvf0) from filing claims for Clean Water Project.”',
    schema: z.strictObject({
      type: z.literal('ixo.entity.revoke-account-authz'),
      entityId: entityDid('The entity that gave the permission.'),
      granteeAddress: address('Who loses it'),
      permission: z
        .literal([...CHAIN_TX_ENTITY_PERMISSIONS])
        .describe('The permission to remove.'),
    }),
  },
  'ixo.entity.grant-account-authz': {
    summary:
      "let an account (or the owner) act for the owner's entity in one way: file or check claims in a collection, change its collections, or give others claim permissions.",
    rules:
      'Gives an account (`granteeAddress`; the owner’s own address is fine) one permission from an entity the owner owns (`entityId`). `permission`: `file-claims` or `check-claims` in one collection (then `collectionId` and `maxClaims`, 1 to 1000000000, are required; optional `reservationSeconds` for file-claims and `decideBefore` for check-claims), or, for every collection of the entity, `change-collection-state`, `change-collection-dates`, `change-collection-quota`, `change-collection-payments` or `authorize-claim-agents` (lets them give others file and check permissions, with no limit); for these five leave `collectionId`, `maxClaims`, `reservationSeconds` and `decideBefore` out. `expiresAt` (optional) ends it; left out, an end date the account already has for this permission is kept, else it never ends. Giving file or check permission for one collection keeps what the account already has for others. Ask who and exactly which permission; never give more than the owner named, and say plainly that changing payments and letting others file or check claims can move money. Say it like: “Let Thandi (ixo1qy…lvf0) check up to 100 claims in the Clean Water collection until 31 December.”',
    schema: z
      .strictObject({
        type: z.literal('ixo.entity.grant-account-authz'),
        entityId: entityDid('The entity that gives the permission.'),
        granteeAddress: address('Who gets the permission'),
        permission: z
          .literal([...CHAIN_TX_ENTITY_PERMISSIONS])
          .describe('The permission to give.'),
        collectionId: uint64(
          'file-claims and check-claims only: the collection (digits).',
        ).optional(),
        maxClaims: claimCount(
          'file-claims and check-claims only: how many claims, 1 to 1000000000.',
        ).optional(),
        reservationSeconds: seconds(
          'file-claims only: how long a reservation holds the payment, in seconds.',
        ).optional(),
        decideBefore: instant(
          'check-claims only: the date checks must be done by.',
        ).optional(),
        expiresAt: instant('Optional: when the permission ends.').optional(),
      })
      .superRefine((message, ctx) => {
        const claims =
          message.permission === 'file-claims' ||
          message.permission === 'check-claims';
        for (const key of ['collectionId', 'maxClaims'] as const) {
          if (claims && message[key] === undefined)
            ctx.addIssue({
              code: 'custom',
              path: [key],
              message: 'Required for file-claims and check-claims.',
            });
          if (!claims && message[key] !== undefined)
            ctx.addIssue({
              code: 'custom',
              path: [key],
              message: 'Only for file-claims and check-claims.',
            });
        }
        roleOptions(message, message.permission, ctx);
      }),
  },
  'ixo.entity.create': {
    summary:
      'create a new entity (a group, project, oracle and so on) that the owner owns.',
    rules:
      'Creates a new entity the owner owns, with its own identity and an account for funds; it can’t be deleted later. `entityType` is lowercase: `dao` (a group), `project`, `oracle`, or `protocol/<kind>` for a template. Its name comes from a Profile document that must ALREADY be stored: `profile` is that document’s https link (`serviceEndpoint`) and `proof` (content id). There is no tool here that stores one: without it the entity has no name until one is linked, so tell the owner. Optional: `protocolId` (the template it is based on, a did:ixo DID) and `startDate`/`endDate`. The runtime adds the owner as its owner. The result does not include the new entity’s id: once the owner has approved it and it went through (hub_action_status), find it with chain_lookup entities. Say it like: “Create a new project called Clean Water, owned by you. It can’t be deleted later.”',
    schema: z
      .strictObject({
        type: z.literal('ixo.entity.create'),
        entityType: z
          .string()
          .max(65)
          .regex(
            ENTITY_TYPE,
            'Lowercase, such as dao, project, oracle or protocol/claim.',
          )
          .describe('The kind of entity.'),
        profile: z
          .strictObject({
            serviceEndpoint: link(
              false,
              'The stored Profile document’s https link.',
            ),
            proof,
          })
          .optional()
          .describe('The already stored Profile document (its name).'),
        protocolId: ixoDid('Optional: the template it is based on.').optional(),
        startDate: instant('Optional: when it starts.').optional(),
        endDate: instant('Optional: when it ends.').optional(),
      })
      .superRefine(endAfterStart),
  },
  'ixo.iid.add-service': {
    summary:
      "add a service link (where apps reach a service) to an entity the owner controls or to the owner's own identity.",
    rules: `${IID_RULES} ${IID_ADD_RULE} \`service\`: \`id\`, \`type\` (the kind of service, for example \`linkedDomains\`) and \`serviceEndpoint\` (an https:// or ipfs:// link). Say it like: “Add the website link https://cleanwater.org to Clean Water Project.”`,
    schema: z.strictObject({
      type: z.literal('ixo.iid.add-service'),
      did: ixoDid('The identity record changed.'),
      service: z.strictObject({
        id: itemId('The new link’s id.'),
        type: iidType('The kind of service.'),
        serviceEndpoint: link(true, 'Where the service is.'),
      }),
    }),
  },
  'ixo.iid.delete-service': {
    summary: 'remove a service link from such an identity.',
    rules: `${IID_RULES} ${IID_REMOVE_RULE} \`serviceId\`: the link’s id. Say it like: “Remove the website link from Clean Water Project.”`,
    schema: z.strictObject({
      type: z.literal('ixo.iid.delete-service'),
      did: ixoDid('The identity record changed.'),
      serviceId: removeId(
        'The id of the link to remove, as the record shows it.',
      ),
    }),
  },
  'ixo.iid.add-linked-resource': {
    summary: 'link a document (a profile, page or file) to such an identity.',
    rules: `${IID_RULES} ${IID_ADD_RULE} The document must already be stored. \`resource\`: \`id\`, \`type\` (for example \`Settings\`), \`description\` (plain words, up to 300), \`mediaType\` (for example \`application/json\`), \`serviceEndpoint\` (where it is stored), \`proof\` (its content id, or "" when it has none), \`encrypted\` (true or false) and optional \`right\`. Say it like: “Link the annual report to Clean Water Project.”`,
    schema: z.strictObject({
      type: z.literal('ixo.iid.add-linked-resource'),
      did: ixoDid('The identity record changed.'),
      resource: z.strictObject({
        id: itemId('The new document link’s id.'),
        type: iidType('The kind of document.'),
        description: linkDescription('What the document is, in plain words.'),
        mediaType: z
          .string()
          .max(MEDIA_TYPE_MAX)
          .regex(MEDIA_TYPE, 'A media type such as application/json.')
          .describe('Its format.'),
        serviceEndpoint: link(true, 'Where it is stored.'),
        proof: linkProof,
        encrypted: z.boolean().describe('true when it is encrypted.'),
        right: linkRight,
      }),
    }),
  },
  'ixo.iid.delete-linked-resource': {
    summary: 'remove a linked document from such an identity.',
    rules: `${IID_RULES} ${IID_REMOVE_RULE} \`resourceId\`: the document link’s id. Say it like: “Remove the annual report from Clean Water Project.”`,
    schema: z.strictObject({
      type: z.literal('ixo.iid.delete-linked-resource'),
      did: ixoDid('The identity record changed.'),
      resourceId: removeId(
        'The id of the document link to remove, as the record shows it.',
      ),
    }),
  },
  'ixo.iid.add-linked-claim': {
    summary: 'link a claim (a credential or record) to such an identity.',
    rules: `${IID_RULES} \`claim\`: \`id\` (the claim’s id), \`type\`, \`description\` (plain words, up to 300), \`serviceEndpoint\` (where it is stored), \`proof\` (its content id, or "" when it has none), \`encrypted\` (true or false) and optional \`right\`. Say it like: “Link the water-quality certificate to Clean Water Project.”`,
    schema: z.strictObject({
      type: z.literal('ixo.iid.add-linked-claim'),
      did: ixoDid('The identity record changed.'),
      claim: z.strictObject({
        id: claimId,
        type: iidType('The kind of claim.'),
        description: linkDescription('What the claim is, in plain words.'),
        serviceEndpoint: link(true, 'Where it is stored.'),
        proof: linkProof,
        encrypted: z.boolean().describe('true when it is encrypted.'),
        right: linkRight,
      }),
    }),
  },
  'ixo.iid.delete-linked-claim': {
    summary: 'remove a linked claim from such an identity.',
    rules: `${IID_RULES} ${IID_REMOVE_RULE} \`claimId\`: the linked claim’s id. Say it like: “Remove the water-quality certificate from Clean Water Project.”`,
    schema: z.strictObject({
      type: z.literal('ixo.iid.delete-linked-claim'),
      did: ixoDid('The identity record changed.'),
      claimId: removeId(
        'The id of the linked claim to remove, as the record shows it.',
      ),
    }),
  },
  'ixo.iid.add-linked-entity': {
    summary:
      'record that another entity is linked to this one, with a relationship such as member or admin.',
    rules: `${IID_RULES} \`entity\`: \`id\` (the other entity’s did:ixo DID, or an ixo1… account or group address, which Portal writes as \`{id}#ixo1…\`), \`type\` (its kind, for example \`dao\`), \`relationship\` (for example \`member\`, \`admin\` or \`Governs\`) and optional \`service\` (a service name of it, "" for none). Apps may use the link to give the other entity a role. Say it like: “Record River Group as a member of Clean Water Project.”`,
    schema: z.strictObject({
      type: z.literal('ixo.iid.add-linked-entity'),
      did: ixoDid('The identity record changed.'),
      entity: z.strictObject({
        id: z
          .string()
          .max(DID_MAX)
          .refine(
            (value) =>
              IXO_DID.test(value) ||
              (value.length <= 67 && LINKED_ENTITY_ADDRESS.test(value)),
            {
              message:
                'A did:ixo:… DID, an ixo1… account or contract address, or {id}#ixo1….',
            },
          )
          .describe('The other entity: its DID or address.'),
        type: iidType('Its kind.'),
        relationship: z
          .string()
          .max(64)
          .regex(
            RELATIONSHIP,
            'Letters, digits, _ or -, starting with a letter (up to 64).',
          )
          .describe('How it is linked, such as member or Governs.'),
        service: z
          .string()
          .max(ITEM_ID_MAX)
          .regex(
            SERVICE_REF,
            'A service name such as svc1, {id}#name, or "" for none.',
          )
          .optional()
          .describe('Optional: a service name of the other entity.'),
      }),
    }),
  },
  'ixo.iid.delete-linked-entity': {
    summary: 'remove the link to another entity from such an identity.',
    rules: `${IID_RULES} ${IID_REMOVE_RULE} \`entityId\`: the linked entity’s id. Say it like: “Remove River Group as a member of Clean Water Project.”`,
    schema: z.strictObject({
      type: z.literal('ixo.iid.delete-linked-entity'),
      did: ixoDid('The identity record changed.'),
      entityId: removeId(
        'The id of the linked entity to remove, as the record shows it.',
      ),
    }),
  },
  'ixo.iid.add-context': {
    summary:
      'add a context reference (how apps read the details) to such an identity.',
    rules: `${IID_RULES} \`context\`: \`key\` (letters, digits, _ or -, starting with a letter) and \`val\` (an https:// link or a did:ixo DID it points to). Say it like: “Tell apps to read Clean Water Project’s details with the IXO vocabulary.”`,
    schema: z.strictObject({
      type: z.literal('ixo.iid.add-context'),
      did: ixoDid('The identity record changed.'),
      context: z.strictObject({
        key: z
          .string()
          .max(64)
          .regex(
            CONTEXT_KEY,
            'Letters, digits, _ or -, starting with a letter (up to 64).',
          )
          .describe('The name of the reference.'),
        val: z
          .string()
          .max(URL_MAX)
          .refine(
            (value) =>
              isLink(value, false) ||
              (value.length <= URL_MAX && IXO_DID.test(value)),
            { message: 'An https:// link or a did:ixo DID, at most 300.' },
          )
          .describe('What it points to.'),
      }),
    }),
  },
  'ixo.iid.delete-context': {
    summary: 'remove a context reference from such an identity.',
    rules: `${IID_RULES} ${IID_REMOVE_RULE} \`key\`: the reference’s name. Say it like: “Remove the IXO vocabulary reference from Clean Water Project.”`,
    schema: z.strictObject({
      type: z.literal('ixo.iid.delete-context'),
      did: ixoDid('The identity record changed.'),
      key: removeId(
        'The name of the reference to remove, as the record shows it.',
      ),
    }),
  },
} as const satisfies Record<ChainTxMessageType, ChainTxCatalogEntry>;

/** What every message type shares, returned once by describe_chain_messages. */
export const CHAIN_TX_GENERAL_RULES = [
  'Addresses are 20-byte `ixo1…` account addresses (contract addresses are refused), validators `ixovaloper1…`, entities `did:ixo:entity:…`. Copy every id, address and number exactly from a lookup (chain_lookup, hub_action_options) or from the owner; never invent or guess one. Ids (`claimId`, `collectionId`, token `id`, proofs) use only letters, digits and `: . _ / -`.',
  'Give only the fields listed for a type: the runtime adds the chain, the network, the signer and the owner’s own DID and address where a message needs them, and Auth Hub sets the fee. Amounts: coin sends and stakes are what the owner says in the token’s units ("100" IXO); impact tokens are whole tokens; collection payments are base units (1 IXO = 1000000 uixo). Dates are RFC 3339 with Z or an offset, from the owner’s time zone.',
  'Up to 8 messages per transaction, run in the order given (put them in the order the owner said them, and keep one decision in one card); all succeed or none do. A step that needs something stored first (a dispute statement, a profile, a document) can only be prepared once it is stored.',
  'How to talk about it: before preparing, say in one or two plain, everyday sentences what will happen and what it means for the owner (what leaves their wallet, what someone else will be able to do, how long it takes, whether it can be undone), the way each type’s “Say it like” does. Use names (of the validator, collection, entity or person) when a lookup gives them. Never say message type names or chain words such as authz, grant, MsgExec, bech32, valoper, uixo, base units, DID, IID, delegate or redelegate: say stake, unstake, move stake, permission, account, identity and IXO. Show an address only when the owner needs it to check who receives something. The review card in Auth Hub shows every exact value.',
].join(' ');

/** A catalogue message as its schema parses it. */
export type ChainTxCatalogMessage = z.output<
  (typeof CHAIN_TX_CATALOG)[ChainTxMessageType]['schema']
>;

/**
 * A parsed catalogue message as the host takes it. The two permission
 * types are one flat object for the model (`role` / `permission` and every
 * option); their schemas refuse an option the role or permission does not
 * take, and this builds the protocol's role- and permission-specific shape
 * from what is left.
 */
export function chainTxMessageInput(
  message: ChainTxCatalogMessage,
): ChainTxMessageInput {
  switch (message.type) {
    case 'ixo.claims.create-claim-authorization': {
      const { role, reservationSeconds, decideBefore, ...rest } = message;
      return role === 'file-claims'
        ? {
            ...rest,
            role,
            ...(reservationSeconds === undefined ? {} : { reservationSeconds }),
          }
        : {
            ...rest,
            role,
            ...(decideBefore === undefined ? {} : { decideBefore }),
          };
    }
    case 'ixo.entity.grant-account-authz': {
      const {
        permission,
        collectionId: collection,
        maxClaims,
        reservationSeconds,
        decideBefore,
        ...rest
      } = message;
      if (permission === 'file-claims' || permission === 'check-claims') {
        // The schema requires both for a claim permission.
        if (collection === undefined || maxClaims === undefined)
          throw new Error(
            'A claim permission without collectionId or maxClaims passed the catalogue schema',
          );
        return permission === 'file-claims'
          ? {
              ...rest,
              permission,
              collectionId: collection,
              maxClaims,
              ...(reservationSeconds === undefined
                ? {}
                : { reservationSeconds }),
            }
          : {
              ...rest,
              permission,
              collectionId: collection,
              maxClaims,
              ...(decideBefore === undefined ? {} : { decideBefore }),
            };
      }
      return { ...rest, permission };
    }
    default:
      return message;
  }
}
