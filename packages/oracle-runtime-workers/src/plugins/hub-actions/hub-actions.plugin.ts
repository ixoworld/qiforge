import {
  CHAIN_TX_MAX_MESSAGES,
  CHAIN_TX_MAX_TOKEN_LINES,
  CHAIN_TX_MESSAGE_TYPES,
  DENOM,
  operationJsonSchema,
  parseOperation,
  type ActionOutcomeV1,
  type ActionReceiptV1,
  type ActionReferenceV1,
  type ChainTxMessageType,
} from '@ixo/action-protocol';
import { z } from 'zod';
import { quoteHubText } from '../../hub-actions/hub-text';
import { OraclePlugin } from '../../plugin-api/oracle-plugin';
import type {
  ChainTxMessageInput,
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import { ixoAddressOf } from '../../core/user-identity';

const configSchema = z.object({
  HUB_ACTIONS_ENABLED: z.enum(['true', 'false']).default('false'),
});

/**
 * Kinds the generic tool never prepares: a chain transaction
 * (`ixo.chain.tx.v1`, coin sends included) is built by the runtime from
 * `request_chain_transaction`'s messages, and the older bank send
 * (`ixo.bank.send.v1`) is no longer prepared by this runtime (Auth Hub
 * still serves it for older runtimes). An application (`ixo.bid.submit.v1`)
 * or a claim (`ixo.claim.submit.v1`) is built by the plugin that runs the
 * claim collection, from the person's answers and the files of the turn
 * (`ctx.session.channel.attachments`): the model never names an evidence
 * link. They are left out of the generic tool's schema (its handler refuses
 * them anyway), which also keeps their branches out of every model request.
 */
export const RUNTIME_BUILT_KINDS: readonly string[] = [
  'ixo.bank.send.v1',
  'ixo.chain.tx.v1',
  'ixo.bid.submit.v1',
  'ixo.claim.submit.v1',
];
function branchKind(branch: Record<string, unknown>): unknown {
  const properties = branch.properties;
  if (!properties || typeof properties !== 'object') return undefined;
  const kind = (properties as Record<string, unknown>).kind;
  return kind && typeof kind === 'object'
    ? (kind as Record<string, unknown>).const
    : undefined;
}
export const requestOperationJsonSchema = {
  ...operationJsonSchema,
  $schema: 'https://json-schema.org/draft/2020-12/schema' as const,
  oneOf: operationJsonSchema.oneOf.filter(
    (branch) => !RUNTIME_BUILT_KINDS.includes(String(branchKind(branch))),
  ),
};
const operationSchema = z.fromJSONSchema(requestOperationJsonSchema);
const requestSchema = z.strictObject({ operation: operationSchema });
const statusSchema = z.strictObject({
  actionId: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
});
const discoverSchema = z.strictObject({});

/**
 * The messages of one chain transaction (`ixo.chain.tx.v1`), as the model
 * writes them. The shapes are the protocol's minus the owner's identity
 * (a claim's `agentDid`, an evaluation's `agentAddress`), which the runtime
 * fills, as it fills the chain id, network and signer; a bank step names a
 * display amount, which the owner object converts to base units from the
 * owner's token list. The protocol parses the whole operation again before
 * it reaches the Hub. The rules match Auth Hub's (ids, address length, DID
 * escapes, memo characters), so a message the Hub would refuse is refused
 * here, before any Hub call.
 */
/** A 20-byte bech32 account address: `ixo1` and 38 characters (a 32-byte contract address is longer). */
const IXO_ADDRESS = /^ixo1[023456789acdefghjklmnpqrstuvwxyz]{38}$/;
const BASE_UNITS = /^[1-9][0-9]{0,77}$/;
/** A DID; `%` only as a `%xx` escape. */
const ANY_DID = /^did:[a-z0-9]+:(?:[A-Za-z0-9._:-]|%[0-9A-Fa-f]{2})+$/;
/** Claim, collection, token and proof ids: no spaces, quotes or markup. */
const ID_CHARS = /^[A-Za-z0-9:._/-]+$/;
const ID_RULE = 'Only letters, digits and : . _ / - (copied exactly).';
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
const MEMO_BYTES = 256;
const address = (what: string) =>
  z
    .string()
    .regex(
      IXO_ADDRESS,
      'A 20-byte ixo1… account address (42 characters); contract addresses are refused.',
    )
    .describe(`${what} (an ixo1… account address).`);
const id = (max: number) => z.string().min(1).max(max).regex(ID_CHARS, ID_RULE);
const baseUnits = (what: string) =>
  z
    .string()
    .regex(BASE_UNITS, 'A whole number of base units above zero.')
    .describe(what);
const claimId = id(256).describe('The claim id, exactly as stored.');
const collectionId = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/, 'Digits only, no leading zeros.')
  .describe('The claim collection id (digits).');

/** A display amount: a plain decimal in the token's units, as the user said it. */
const DISPLAY_AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/**
 * One chain-transaction message type: the one-line `summary` the request
 * tool's description lists, the full `rules` describe_chain_messages
 * returns (with the fields of `schema`), and the strict `schema` the
 * request handler checks each message against. Adding a message type is
 * one entry here (once `@ixo/action-protocol` and Auth Hub support it).
 */
interface ChainTxCatalogEntry {
  summary: string;
  rules: string;
  schema: z.ZodObject;
}

export const CHAIN_TX_CATALOG = {
  'cosmos.bank.send': {
    summary:
      "send coins (IXO or another token the owner holds) from the owner's wallet.",
    rules: [
      "Sends coins from the owner's wallet to `toAddress`, alone (a single coin send) or as a step of a batch.",
      '`amount` is the amount as the user said it, in the token’s display units ("1.5" for 1.5 IXO): a plain decimal, never base units. The runtime looks the token up in the owner’s token list (hub_action_options `transfer.tokens`), converts the amount with the listed `decimals`, and refuses a token not in the list, more digits after the point than the token has, zero, and more than the listed balance (the bank steps of one token together).',
      '`denom` is optional and defaults to uixo (IXO, 6 decimals). For another token copy its `denom` exactly from `transfer.tokens` (never guess an `ibc/…` hash); name the full denom to the owner for anything but IXO, and say when the token is unverified (it lists 0 decimals: its amount is a whole number of base units).',
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
      'Files a claim the owner has already created with a claim collection. `claimId` is the stored claim’s id, `collectionId` the collection, `adminAddress` the collection admin’s address. The runtime adds the owner’s DID as the filer. The collection admin must have authorized the owner to submit claims. Collections with member budgets cannot be filed into here (no member address is sent). Set `useIntent` only when the collection works with intents.',
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
      'Records the owner’s decision, as evaluator, on someone else’s claim (`claimId` in `collectionId`). `status` 1 approve, 2 reject, 3 dispute (the chain may refuse it as deprecated), 4 invalidate. It is recorded as the owner’s (the runtime adds their DID and address, never the claimant’s); `oracle` is the evaluator DID recorded on the evaluation (normally the owner’s DID, or the oracle entity DID the collection admin authorized); `adminAddress` is the collection admin’s address; `reason` (a number) and `verificationProof` are optional. The collection admin must have authorized the owner as an evaluator. An approval can pay the claimant.',
    schema: z.strictObject({
      type: z.literal('ixo.claims.evaluate'),
      claimId,
      collectionId,
      oracle: z
        .string()
        .max(200)
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
    rules: `Moves IXO impact tokens (1155-style: each line a token \`id\` of 32 hex characters and a whole \`amount\`, 1 to ${CHAIN_TX_MAX_TOKEN_LINES} lines) from the owner’s wallet to \`recipient\`. Impact tokens have no decimals: an amount is a whole number of tokens. All tokens in one message must come from one token contract. These are not the IXO coin: coins go through \`cosmos.bank.send\`.`,
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
} as const satisfies Record<ChainTxMessageType, ChainTxCatalogEntry>;

/** What every message type shares, returned once by describe_chain_messages. */
export const CHAIN_TX_GENERAL_RULES =
  'Addresses are 20-byte `ixo1…` account addresses (contract addresses are refused). Ids (`claimId`, `collectionId`, token `id`, `verificationProof`) use only letters, digits and `: . _ / -`; copy them exactly and never invent them. Give only the fields listed for a type: the runtime adds the chain, the network, the signer and the owner’s own DID and address where a message needs them, and Auth Hub sets the fee. Up to 8 messages per transaction, run in order; all succeed or none do.';

const memoSchema = z
  .string()
  .max(MEMO_BYTES)
  .refine((memo) => new TextEncoder().encode(memo).length <= MEMO_BYTES, {
    message: `At most ${MEMO_BYTES} bytes.`,
  })
  .refine((memo) => !hasUnsafeText(memo), {
    message: 'No control, invisible or text-direction characters.',
  })
  .optional()
  .describe('An optional note shown to the owner and kept on chain.');

/**
 * A catalogue field reduced to its basic type: no descriptions, patterns or
 * limits (those stay in describe_chain_messages and the handler's check).
 */
export function fieldsOnly(schema: z.core.$ZodType): z.ZodType {
  if (schema instanceof z.ZodObject)
    return z.strictObject(
      Object.fromEntries(
        Object.entries(schema.shape).map(([key, field]) => [
          key,
          fieldsOnly(field),
        ]),
      ),
    );
  if (schema instanceof z.ZodOptional)
    return fieldsOnly(schema.unwrap()).optional();
  if (schema instanceof z.ZodArray) return z.array(fieldsOnly(schema.element));
  if (schema instanceof z.ZodString) return z.string();
  if (schema instanceof z.ZodNumber) return z.number();
  if (schema instanceof z.ZodBoolean) return z.boolean();
  if (schema instanceof z.ZodLiteral) return z.literal([...schema.values]);
  throw new Error(
    `No model-facing form for a ${schema._zod.def.type} field in the chain transaction catalogue`,
  );
}

/**
 * One message type as the model is given it: its field names and basic
 * types, so a provider that holds a tool call to its schema sends every
 * field. Loose, so a field the type does not have reaches the handler,
 * which names it.
 */
function messageFieldsOnly(schema: z.ZodObject) {
  return z.looseObject(
    Object.fromEntries(
      Object.entries(schema.shape).map(([key, field]) => [
        key,
        fieldsOnly(field),
      ]),
    ),
  );
}

/**
 * The schema the model is given: per type, its fields (messageFieldsOnly),
 * so a type adds its short field list and the rules are fetched with
 * describe_chain_messages when needed. Each message is then checked by the
 * handler against its full catalogue schema.
 */
export function chainTransactionSchemaFor(
  catalog: Readonly<Record<string, { schema: z.ZodObject }>>,
) {
  const [first, ...rest] = Object.values(catalog).map((entry) =>
    messageFieldsOnly(entry.schema),
  );
  if (!first) throw new Error('The chain transaction catalogue is empty');
  return z.strictObject({
    messages: z
      .array(z.discriminatedUnion('type', [first, ...rest]))
      .min(1)
      .max(CHAIN_TX_MAX_MESSAGES),
    memo: memoSchema,
  });
}
const chainTransactionSchema = chainTransactionSchemaFor(CHAIN_TX_CATALOG);

/**
 * The request tool's description: what it does, the discovery step, one
 * line per catalogue type (its summary only) and the batch rules. A new
 * type adds one line.
 */
export function chainTransactionDescription(
  catalog: Readonly<Record<string, { summary: string }>>,
): string {
  return [
    'Prepare one chain transaction for the owner (the person you are talking to) to review and sign in Auth Hub; it never signs or executes. A single coin send is one `cosmos.bank.send` message. Before the first use in a conversation, call describe_chain_messages for the types you need and give exactly the fields it lists. Message types:',
    ...Object.entries(catalog).map(
      ([type, entry]) => `- \`${type}\`: ${entry.summary}`,
    ),
    'Up to 8 messages run in order as one transaction: all succeed or none do. Never invent ids or addresses (ask the owner or use other tools); coin amounts are display units ("1.5"), never base units. When the result is unavailable, tell the owner its reason in plain words; when it says retrying or changing the fields will not help, do not retry.',
  ].join('\n');
}
export const CHAIN_TRANSACTION_TOOL_DESCRIPTION =
  chainTransactionDescription(CHAIN_TX_CATALOG);

const describeChainMessagesSchema = z.strictObject({
  types: z
    .array(z.enum(CHAIN_TX_MESSAGE_TYPES))
    .min(1)
    .max(CHAIN_TX_MAX_MESSAGES)
    .refine((types) => new Set(types).size === types.length, {
      message: 'Name each type once.',
    })
    .describe('The message types to describe, each once.'),
});

export const DESCRIBE_CHAIN_MESSAGES_TOOL_DESCRIPTION =
  'Read the full rules of chain-transaction message types before using them in request_chain_transaction: every field with its meaning, format and limits, what the runtime fills, and chain caveats. Ask only for the types you need. Also returns `availableTypes`: the types this account may use.';

export type HubActionRequestResult =
  | {
      status: 'prepared';
      actionReference: ActionReferenceV1;
      summary: string;
      /** How the review reaches the user; set on a chat surface only. */
      note?: string;
    }
  | {
      status: 'unavailable' | 'expired';
      reason: string;
      /** The earlier action that blocks this one (an unconfirmed email). */
      priorActionId?: string;
    };

/**
 * What a prepared result tells the model on a chat surface. There the
 * finished run's Reply Plan carries the review as its own `hub-action` part
 * (a card with the title and a review button; its title linked to the review
 * in a plain-text rendering), so text that repeats it reaches the user twice.
 */
export const HUB_ACTION_CARD_NOTE =
  'The user is shown this action automatically as a card with its title and a Review action button that opens it in Auth Hub. Do not repeat the link or the title, and do not say that you have not executed or signed anything. Reply with one short line, or nothing.';

/**
 * A prepared result. Only a chat turn's reply is a Reply Plan, so only a
 * chat surface gets the note: on the Portal stream no card is added and the
 * model's own text is the whole reply.
 */
function preparedResult(
  reference: ActionReferenceV1,
  ctx: RuntimeContext,
): HubActionRequestResult {
  return {
    status: 'prepared',
    actionReference: reference,
    summary: reference.title,
    ...(ctx.session.surface?.kind === 'chat'
      ? { note: HUB_ACTION_CARD_NOTE }
      : {}),
  };
}

/**
 * The idempotency key the Hub sees: a fixed-length digest of the run and
 * tool call (the Hub allows 120 characters; a run id alone is 72).
 */
async function hubRequestKey(runId: string, toolCallId: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${runId}:${toolCallId}`),
    ),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function requestHubAction(
  input: unknown,
  ctx: RuntimeContext,
): Promise<HubActionRequestResult> {
  // Named before the schema check: the schema has no branch for these kinds.
  const kind =
    input &&
    typeof input === 'object' &&
    'operation' in input &&
    input.operation &&
    typeof input.operation === 'object' &&
    'kind' in input.operation
      ? input.operation.kind
      : undefined;
  if (kind === 'ixo.bank.send.v1')
    // A coin send is a `cosmos.bank.send` step of a chain transaction,
    // built by the runtime from a listed token and a display amount: the
    // model never supplies base units, a denom it chose or a fee.
    return {
      status: 'unavailable',
      reason:
        'Use request_chain_transaction with one cosmos.bank.send message (a token from hub_action_options and the amount in its display units) for a coin send.',
    };
  if (kind === 'ixo.chain.tx.v1')
    // The runtime adds the chain, network, signer and owner identity itself.
    return {
      status: 'unavailable',
      reason:
        'Use request_chain_transaction with only the messages for a chain transaction.',
    };
  if (kind === 'ixo.bid.submit.v1' || kind === 'ixo.claim.submit.v1')
    return {
      status: 'unavailable',
      reason:
        'Applications and claims are prepared by the tools of the plugin that runs the claim collection, never with request_hub_action.',
    };
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success)
    return { status: 'unavailable', reason: 'An operation is required.' };
  if (ctx.config.HUB_ACTIONS_ENABLED !== 'true' || !ctx.hubActions)
    return {
      status: 'unavailable',
      reason: 'Hub actions are not enabled for this oracle.',
    };
  const channel = ctx.session.channel;
  if (
    ctx.session.client !== 'channel' ||
    !channel ||
    !ctx.session.runId ||
    !ctx.toolCallId
  )
    return {
      status: 'unavailable',
      reason: 'A verified channel turn is required.',
    };
  let operation;
  try {
    operation = parseOperation(parsed.data.operation);
  } catch (error) {
    // The protocol's own words ("Invalid fromAddress"): the model can fix
    // the field instead of guessing.
    return {
      status: 'unavailable',
      reason: `The requested operation is unsupported or incomplete${error instanceof Error && error.message ? ` (${error.message})` : ''}.`,
    };
  }
  let reference: ActionReferenceV1;
  try {
    reference = await ctx.hubActions.request({
      ownerDid: ctx.user.did,
      sessionId: ctx.session.id,
      runId: ctx.session.runId,
      requestId: ctx.session.requestId,
      provider: channel.provider,
      bindingId: channel.bindingId,
      bindingRevision: channel.bindingRevision,
      requestKey: await hubRequestKey(ctx.session.runId, ctx.toolCallId),
      operation,
    });
  } catch (error) {
    // A request that expired, a run no user message started, a Hub
    // refusal: the runtime's own words, so the model can tell the user.
    // Anything else stays an error.
    const refused = refusalOf(error);
    if (refused) return refused;
    throw error;
  }
  return preparedResult(reference, ctx);
}

async function requestChainTransaction(
  input: unknown,
  ctx: RuntimeContext,
): Promise<HubActionRequestResult> {
  const parsed = chainTransactionSchema.safeParse(input);
  if (!parsed.success) return chainTxShapeRefusal(issuesOf(parsed.error));
  const checked = strictChainTxMessages(parsed.data.messages);
  if ('issues' in checked) return chainTxShapeRefusal(checked.issues);
  if (ctx.config.HUB_ACTIONS_ENABLED !== 'true' || !ctx.hubActions)
    return {
      status: 'unavailable',
      reason: 'Hub actions are not enabled for this oracle.',
    };
  const channel = ctx.session.channel;
  if (
    ctx.session.client !== 'channel' ||
    !channel ||
    !ctx.session.runId ||
    !ctx.toolCallId
  )
    return {
      status: 'unavailable',
      reason: 'A verified channel turn is required.',
    };
  try {
    const reference = await ctx.hubActions.chainTransaction({
      ownerDid: ctx.user.did,
      sessionId: ctx.session.id,
      runId: ctx.session.runId,
      requestId: ctx.session.requestId,
      provider: channel.provider,
      bindingId: channel.bindingId,
      bindingRevision: channel.bindingRevision,
      requestKey: await hubRequestKey(ctx.session.runId, ctx.toolCallId),
      messages: checked.messages,
      memo: parsed.data.memo ?? '',
    });
    return preparedResult(reference, ctx);
  } catch (error) {
    // The runtime refusing (turn origin, capabilities, a token or amount,
    // the protocol on a field) or the Hub refusing with its reason: words
    // the model relays.
    const refused = refusalOf(error);
    if (refused) return refused;
    throw error;
  }
}

/**
 * Each message against its type's catalogue schema (strict: a field the
 * type does not have, the owner's identity included, is refused). The
 * model-facing schema only names the fields and their basic types, so this
 * is where a message's formats and limits are checked, on a model turn as on
 * a direct call.
 */
function strictChainTxMessages(
  messages: readonly unknown[],
): { messages: ChainTxMessageInput[] } | { issues: string[] } {
  const checked: ChainTxMessageInput[] = [];
  const issues: string[] = [];
  messages.forEach((message, index) => {
    const type = chainTxTypeOf(message);
    if (!type) {
      issues.push(`messages[${index}].type: not a known message type`);
      return;
    }
    const result = CHAIN_TX_CATALOG[type].schema.safeParse(message);
    if (result.success) checked.push(result.data);
    else issues.push(...issuesOf(result.error, ['messages', index]));
  });
  return issues.length ? { issues } : { messages: checked };
}

function chainTxTypeOf(message: unknown): ChainTxMessageType | null {
  if (typeof message !== 'object' || message === null || !('type' in message))
    return null;
  const { type } = message;
  return CHAIN_TX_MESSAGE_TYPES.find((known) => known === type) ?? null;
}

function chainTxShapeRefusal(
  issues: readonly string[],
): HubActionRequestResult {
  return {
    status: 'unavailable',
    reason: `The messages do not match a supported message shape (check ${[...new Set(issues)].slice(0, 5).join('; ')}).`,
  };
}

/** `messages[1].toAddress`, from a zod path. */
function pathText(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (text, key) =>
      typeof key === 'number'
        ? `${text}[${key}]`
        : text
          ? `${text}.${String(key)}`
          : String(key),
    '',
  );
}

/**
 * Each refused field as `path: what is wrong` (`messages[1].toAddress: A
 * 20-byte ixo1… account address …`); a field the shape does not have is
 * named on its own path.
 */
function issuesOf(
  error: z.ZodError,
  prefix: readonly PropertyKey[] = [],
): string[] {
  return error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map(
          (key) =>
            `${pathText([...prefix, ...issue.path, key])}: not a field here (describe_chain_messages lists each type's fields)`,
        )
      : [
          `${pathText([...prefix, ...issue.path]) || 'arguments'}: ${issue.message.replace(/\.$/, '')}`,
        ],
  );
}

/**
 * The catalogue types this account may use: the Hub capabilities'
 * `chainTx.messageTypes` (none when chain transactions are off for the
 * account), or the whole catalogue when the capabilities cannot be read
 * (not a channel turn, or the Hub did not answer).
 */
async function availableChainTxTypes(
  ctx: RuntimeContext,
): Promise<readonly ChainTxMessageType[]> {
  if (
    ctx.config.HUB_ACTIONS_ENABLED !== 'true' ||
    ctx.session.client !== 'channel' ||
    !ctx.session.channel ||
    !ctx.hubActions
  )
    return CHAIN_TX_MESSAGE_TYPES;
  let chainTx;
  try {
    chainTx = (await ctx.hubActions.capabilities()).chainTx;
  } catch (error) {
    ctx.logger.warn(
      `[hub-actions] capabilities unavailable for describe_chain_messages: ${error instanceof Error ? error.message : String(error)}`,
    );
    return CHAIN_TX_MESSAGE_TYPES;
  }
  return CHAIN_TX_MESSAGE_TYPES.filter((type) =>
    chainTx?.messageTypes.includes(type),
  );
}

/** Each type's fields as JSON Schema, built once. */
const catalogueFields = new Map<ChainTxMessageType, unknown>();
function fieldsOf(type: ChainTxMessageType): unknown {
  let fields = catalogueFields.get(type);
  if (fields === undefined) {
    const { properties, required } = z.toJSONSchema(
      CHAIN_TX_CATALOG[type].schema,
    );
    fields = { properties, required };
    catalogueFields.set(type, fields);
  }
  return fields;
}

async function describeChainMessages(
  input: unknown,
  ctx: RuntimeContext,
): Promise<unknown> {
  const parsed = describeChainMessagesSchema.safeParse(input);
  if (!parsed.success)
    return {
      status: 'unavailable',
      reason: `Name 1 to ${CHAIN_TX_MAX_MESSAGES} different message types, each one of: ${CHAIN_TX_MESSAGE_TYPES.join(', ')}.`,
    };
  return {
    status: 'known',
    general: CHAIN_TX_GENERAL_RULES,
    messages: parsed.data.types.map((type) => ({
      type,
      rules: CHAIN_TX_CATALOG[type].rules,
      fields: fieldsOf(type),
    })),
    availableTypes: await availableChainTxTypes(ctx),
  };
}

/** A typed runtime refusal as a result the model can relay, else null. */
function refusalOf(error: unknown): HubActionRequestResult | null {
  if (
    error instanceof Error &&
    error.name === 'HubActionRefused' &&
    'kind' in error
  )
    return {
      status: error.kind === 'expired' ? 'expired' : 'unavailable',
      reason: error.message,
      ...('priorActionId' in error && typeof error.priorActionId === 'string'
        ? { priorActionId: error.priorActionId }
        : {}),
    };
  return null;
}

/**
 * A receipt as the model reads it. A failure receipt keeps only its plain
 * fields: the Hub's `message` (its words for the person) is quoted and
 * labelled as data, and anything else the Hub adds, its technical `detail`
 * included (for the review page only), is left out. A chain transaction's
 * `message` is quoted the same way. Every other receipt passes as
 * `@ixo/action-protocol` parsed it (exact keys, no free Hub text).
 */
export function modelReceipt(
  receipt: ActionReceiptV1 | null,
): Record<string, unknown> | null {
  if (!receipt) return null;
  if (receipt.kind === 'ixo.submission.failed.v1')
    return {
      kind: receipt.kind,
      actionId: receipt.actionId,
      revision: receipt.revision,
      digest: receipt.digest,
      step: receipt.step,
      message: quoteHubText('message', receipt.message),
      failedAt: receipt.failedAt,
    };
  if (receipt.kind === 'ixo.chain.tx.v1' && receipt.message !== undefined)
    return { ...receipt, message: quoteHubText('message', receipt.message) };
  return { ...receipt };
}

/** An outcome as the model reads it: its receipt through `modelReceipt`. */
export function modelOutcome(
  outcome: ActionOutcomeV1 | null,
): Record<string, unknown> | null {
  if (!outcome) return null;
  return { ...outcome, receipt: modelReceipt(outcome.receipt) };
}

async function hubActionStatus(
  input: unknown,
  ctx: RuntimeContext,
): Promise<unknown> {
  const parsed = statusSchema.safeParse(input);
  if (
    !parsed.success ||
    !ctx.hubActions ||
    ctx.config.HUB_ACTIONS_ENABLED !== 'true'
  )
    return { status: 'unavailable' };
  try {
    const read = await ctx.hubActions.status(
      ctx.user.did,
      parsed.data.actionId,
    );
    if (!read.held)
      return {
        status: 'unavailable',
        reason: 'No Hub action with this id was prepared for this owner.',
      };
    return {
      status: 'known',
      reviewStatus: read.reviewStatus,
      operationStatus: read.operationStatus,
      outcome: modelOutcome(read.outcome),
      ...(read.summary ? { summary: read.summary } : {}),
    };
  } catch (error) {
    // An Auth Hub that must be updated first: plain words, not a tool error.
    const refused = refusalOf(error);
    if (refused) return refused;
    throw error;
  }
}

async function hubActionCapabilities(
  _input: unknown,
  ctx: RuntimeContext,
): Promise<unknown> {
  if (
    ctx.config.HUB_ACTIONS_ENABLED !== 'true' ||
    ctx.session.client !== 'channel' ||
    !ctx.session.channel ||
    !ctx.hubActions
  )
    return { status: 'unavailable' };
  try {
    return await ctx.hubActions.capabilities();
  } catch (error) {
    const refused = refusalOf(error);
    if (refused) return refused;
    throw error;
  }
}

async function hubActionOptions(
  _input: unknown,
  ctx: RuntimeContext,
): Promise<unknown> {
  const channel = ctx.session.channel;
  if (
    ctx.config.HUB_ACTIONS_ENABLED !== 'true' ||
    ctx.session.client !== 'channel' ||
    !channel ||
    !ctx.hubActions
  )
    return { status: 'unavailable' };
  let options;
  try {
    options = await ctx.hubActions.options({
      ownerDid: ctx.user.did,
      provider: channel.provider,
      bindingId: channel.bindingId,
      bindingRevision: channel.bindingRevision,
    });
  } catch (error) {
    const refused = refusalOf(error);
    if (refused) return refused;
    throw error;
  }
  // The address is read off the owner's DID, so the model can name the
  // account the listed balances belong to without a lookup.
  return { ...options, ownerAddress: ixoAddressOf(ctx.user.did) };
}

const manifest: PluginManifest = {
  title: 'Auth Hub action review',
  summary:
    'Prepare a registered operation for owner review and read its verified status.',
  whenToUse: [
    'The user requests a registered form submission or a coin send.',
    'The user asks to file or evaluate a claim, or to send coins or impact tokens on chain.',
    'The user asks to review an exact private resource or to sign a statement.',
    'The user asks to connect Gmail or Calendar, send a reviewed email or add an event.',
    'The user asks for document access or to save a private note.',
  ],
  whenNotToUse: [
    'Signing, executing, or treating a resource open as acceptance.',
  ],
  tags: ['actions', 'channels'],
  category: 'integration',
  visibility: 'on-demand',
  stability: 'experimental',
};

export class HubActionsPlugin extends OraclePlugin {
  readonly name = 'hub-actions';
  readonly version = '0.1.0';
  readonly manifest = manifest;
  override readonly configSchema = configSchema;
  /** The flag alone is not enough: the owner object needs the Hub's URL and this oracle's key. */
  override autoDetect(env: Record<string, unknown>): boolean {
    return (
      env.HUB_ACTIONS_ENABLED === 'true' &&
      typeof env.AUTH_HUB_URL === 'string' &&
      env.AUTH_HUB_URL.length > 0 &&
      typeof env.AUTH_HUB_CHANNEL_SERVICE_KEY === 'string' &&
      env.AUTH_HUB_CHANNEL_SERVICE_KEY.length > 0
    );
  }
  override getTools(): PluginTool[] {
    return [
      {
        name: 'hub_action_capabilities',
        description:
          "Read this authenticated oracle account's enabled operation kinds and exact registered form field schema before proposing a Hub action.",
        schema: discoverSchema,
        effect: 'read',
        handler: hubActionCapabilities,
      },
      {
        name: 'hub_action_options',
        description:
          "Read this authenticated owner’s confirmed Gmail and Calendar connections, requestable documents, action resources and bank tokens (`transfer.tokens`: denom, symbol, decimals, verified, balance in base units). Use each returned service, identifier and label before preparing a related Hub review. A Gmail profile connection does not authorize sending. For a token that is not verified, name its full denom and say it is unverified; its amounts are base units. ownerDid is the authenticated user's DID and ownerAddress their IXO account address.",
        schema: discoverSchema,
        effect: 'read',
        handler: hubActionOptions,
      },
      {
        name: 'request_hub_action',
        description:
          'Prepare a supported operation for the authenticated channel owner to review in Auth Hub. Never approves, signs, or executes. For email, propose one plain-text message to one recipient using a confirmed Gmail send connection. Supply only the operation candidate; the runtime supplies identity and turn binding. Coin sends and other chain transactions have their own tool (request_chain_transaction). Never prepare a replacement email after an unknown send without the user checking Gmail’s Sent folder and asking again.',
        schema: requestSchema,
        effect: 'write',
        handler: requestHubAction,
      },
      {
        name: 'describe_chain_messages',
        description: DESCRIBE_CHAIN_MESSAGES_TOOL_DESCRIPTION,
        schema: describeChainMessagesSchema,
        effect: 'read',
        handler: describeChainMessages,
      },
      {
        name: 'request_chain_transaction',
        description: CHAIN_TRANSACTION_TOOL_DESCRIPTION,
        schema: chainTransactionSchema,
        effect: 'write',
        handler: requestChainTransaction,
      },
      {
        name: 'hub_action_status',
        description:
          'Read the verified status of a Hub action already prepared for this owner. Never executes.',
        schema: statusSchema,
        effect: 'read',
        handler: hubActionStatus,
      },
    ];
  }
}
