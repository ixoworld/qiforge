import {
  CHAIN_TX_GROUP_MESSAGE_TYPES,
  CHAIN_TX_MAX_MESSAGES,
  CHAIN_TX_MESSAGE_TYPES,
  operationJsonSchema,
  parseOperation,
  type ActionOutcomeV1,
  type ActionReceiptV1,
  type ActionReferenceV1,
  type ChainTxMessageType,
} from '@ixo/action-protocol';
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { createMiddleware, type AgentMiddleware } from 'langchain';
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
import { toolNotRunMessage } from '../../core/tool-not-run';
import {
  CHAIN_TX_CATALOG,
  CHAIN_TX_GENERAL_RULES,
  GROUP_ACTION_SCHEMA,
  GROUP_ACTION_TYPES,
  chainTxMessageInput,
  hasUnsafeText,
} from './chain-tx-catalog';

export {
  CHAIN_TX_CATALOG,
  CHAIN_TX_GENERAL_RULES,
  hasUnsafeText,
} from './chain-tx-catalog';

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

const MEMO_BYTES = 256;
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
 * A union of message types (a new group proposal's `actions`) is given as
 * `typeUnion` gives the messages themselves: fields only for the types in
 * `described`.
 */
export function fieldsOnly(
  schema: z.core.$ZodType,
  described?: ReadonlySet<string>,
): z.ZodType {
  if (schema instanceof z.ZodObject)
    return z.strictObject(
      Object.fromEntries(
        Object.entries(schema.shape).map(([key, field]) => [
          key,
          fieldsOnly(field, described),
        ]),
      ),
    );
  if (schema instanceof z.ZodOptional)
    return fieldsOnly(schema.unwrap(), described).optional();
  if (schema instanceof z.ZodNullable)
    return fieldsOnly(schema.unwrap(), described).nullable();
  if (schema instanceof z.ZodArray)
    return z.array(fieldsOnly(schema.element, described));
  if (schema instanceof z.ZodDiscriminatedUnion)
    return typeUnion(
      schema.options.map((option) => {
        if (!(option instanceof z.ZodObject))
          throw new Error('A message union holds a non-object branch');
        return [messageTypeOf(option), option] as const;
      }),
      described,
    );
  if (schema instanceof z.ZodString) return z.string();
  if (schema instanceof z.ZodNumber) return z.number();
  if (schema instanceof z.ZodBoolean) return z.boolean();
  if (schema instanceof z.ZodLiteral) return z.literal([...schema.values]);
  throw new Error(
    `No model-facing form for a ${schema._zod.def.type} field in the chain transaction catalogue`,
  );
}

/** The `type` a catalogue message schema is for (its `type` literal). */
function messageTypeOf(schema: z.ZodObject): string {
  const type = schema.shape.type;
  const [value] = type instanceof z.ZodLiteral ? [...type.values] : [];
  if (typeof value !== 'string')
    throw new Error('A catalogue message schema has no `type` literal');
  return value;
}

/**
 * One message type as the model is given it: its field names and basic
 * types, so a provider that holds a tool call to its schema sends every
 * field. Loose, so a field the type does not have reaches the handler,
 * which names it.
 */
function messageFieldsOnly(
  schema: z.ZodObject,
  described?: ReadonlySet<string>,
) {
  return z.looseObject(
    Object.fromEntries(
      Object.entries(schema.shape).map(([key, field]) => [
        key,
        fieldsOnly(field, described),
      ]),
    ),
  );
}

/**
 * Messages as the model is given them: per type its fields
 * (messageFieldsOnly) when the type was described in this session
 * (`described`; absent: every type), and one open branch naming every
 * other type (`type` one of them, any other field allowed). A union inside
 * a message (a new group proposal's `actions`) takes `nested` instead.
 */
function typeUnion(
  schemas: readonly (readonly [string, z.ZodObject])[],
  described?: ReadonlySet<string>,
  nested: ReadonlySet<string> | undefined = described,
) {
  const withFields = schemas
    .filter(([type]) => !described || described.has(type))
    .map(([, schema]) => messageFieldsOnly(schema, nested));
  const [firstUnread, ...unread] = schemas
    .filter(([type]) => described && !described.has(type))
    .map(([type]) => type);
  const branches =
    firstUnread === undefined
      ? withFields
      : [
          ...withFields,
          z.looseObject({ type: z.literal([firstUnread, ...unread]) }),
        ];
  const [first, ...rest] = branches;
  if (!first) throw new Error('The chain transaction catalogue is empty');
  return z.discriminatedUnion('type', [first, ...rest]);
}

/**
 * The schema the model is given: the messages as `typeUnion` gives them,
 * a new group proposal's actions the same way. A type the model has not
 * read about costs its name only; the request handler refuses it until it
 * is described, and the next model call is given its fields
 * (`chainTxFieldsMiddleware`). Without a session store (`described`
 * absent) every message type carries its fields, but a new proposal's
 * actions are named only: the 14 action types' fields would repeat their
 * top-level branches (26 228 characters instead of 20 950); the
 * handler names any field it misses. Each message is checked by the
 * handler against its full catalogue schema.
 */
export function chainTransactionSchemaFor(
  catalog: Readonly<Record<string, { schema: z.ZodObject }>>,
  described?: ReadonlySet<string>,
) {
  return z.strictObject({
    messages: z
      .array(
        typeUnion(
          Object.entries(catalog).map(
            ([type, entry]) => [type, entry.schema] as const,
          ),
          described,
          described ?? new Set<string>(),
        ),
      )
      .min(1)
      .max(CHAIN_TX_MAX_MESSAGES),
    memo: memoSchema,
  });
}

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
    'Up to 8 messages run in order as one transaction: all succeed or none do. Never invent ids or addresses (ask the owner or use other tools); coin and stake amounts are display units ("1.5"), never base units. Tell the owner what will happen in plain everyday words, never message type names or chain terms. When the result is unavailable, tell the owner its reason in plain words; when it says retrying or changing the fields will not help, do not retry.',
  ].join('\n');
}

/** The catalogue entries of `types`, in catalogue order. */
function catalogOf(types: readonly ChainTxMessageType[]) {
  return Object.fromEntries(
    CHAIN_TX_MESSAGE_TYPES.filter((type) => types.includes(type)).map(
      (type) => [type, CHAIN_TX_CATALOG[type]],
    ),
  );
}

/**
 * request_chain_transaction for the message types this account may use
 * (`availableChainTxTypes`): the model is given their summaries, and the
 * fields of those `described` in this session (null: of every one), so it
 * neither sees nor pays for a type Auth Hub would refuse or one it has not
 * read about, and its arguments are checked against the same schema (a
 * message of another type is refused before any Hub call). Null when the
 * account may use none (describe_chain_messages then answers
 * `availableTypes: []`). Built once per (types, described) pair.
 */
export function chainTransactionTool(
  types: readonly ChainTxMessageType[],
  described: readonly ChainTxMessageType[] | null = null,
): PluginTool | null {
  const catalog = catalogOf(types);
  if (!Object.keys(catalog).length) return null;
  const fields = described
    ? new Set(
        Object.keys(catalog).filter((type) =>
          described.some((d) => d === type),
        ),
      )
    : undefined;
  const key = `${Object.keys(catalog).join(',')}|${fields ? [...fields].join(',') : '*'}`;
  const cached = chainTransactionTools.get(key);
  if (cached) {
    // Most recently used last, so the bound below drops the oldest.
    chainTransactionTools.delete(key);
    chainTransactionTools.set(key, cached);
    return cached;
  }
  const schema = chainTransactionSchemaFor(catalog, fields);
  const tool: PluginTool = {
    name: 'request_chain_transaction',
    description: chainTransactionDescription(catalog),
    schema,
    effect: 'write',
    handler: (input, ctx) => requestChainTransaction(schema, input, ctx),
  };
  // Type lists come from Auth Hub capabilities (one or two per deployment)
  // and described sets from sessions; the bound keeps the map small, the
  // least recently used pair is built again when needed.
  if (chainTransactionTools.size >= CHAIN_TRANSACTION_TOOL_CACHE)
    chainTransactionTools.delete(chainTransactionTools.keys().next().value!);
  chainTransactionTools.set(key, tool);
  return tool;
}
const CHAIN_TRANSACTION_TOOL_CACHE = 32;

/**
 * The message types described in a conversation (`describe_chain_messages`),
 * per session id in the owner's own key-value rows, each with the run that
 * first described it: durable across restarts of the owner object, kept
 * while used (`DESCRIBED_IDLE_TTL_MS`), and at most `DESCRIBED_MAX_SESSIONS`
 * sessions per owner. A new session starts with none.
 */
const DESCRIBED_NAMESPACE = 'hub-actions/chain-tx-described';
const DESCRIBED_IDLE_TTL_MS = 7 * 24 * 60 * 60_000;
const DESCRIBED_MAX_SESSIONS = 200;

/** The stored `{type: runId}` record of a session (anything else: none). */
function describedRecord(
  value: unknown,
): Partial<Record<ChainTxMessageType, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record: Partial<Record<ChainTxMessageType, string>> = {};
  for (const type of CHAIN_TX_MESSAGE_TYPES) {
    const run: unknown = Reflect.get(value, type);
    if (typeof run === 'string') record[type] = run;
  }
  return record;
}

/**
 * The types whose rules a `describe_chain_messages` call in `messages` read:
 * its arguments (on the AI message that made the call), counted only when
 * its result is there too and is not an error.
 */
function describedInHistory(
  messages: readonly BaseMessage[],
): Set<ChainTxMessageType> {
  const calls = new Map<string, unknown>();
  for (const message of messages)
    if (AIMessage.isInstance(message))
      for (const call of message.tool_calls ?? [])
        if (call.name === 'describe_chain_messages' && call.id)
          calls.set(call.id, call.args);
  const described = new Set<ChainTxMessageType>();
  for (const message of messages) {
    if (
      !ToolMessage.isInstance(message) ||
      message.name !== 'describe_chain_messages' ||
      message.status === 'error'
    )
      continue;
    const args = describeChainMessagesSchema.safeParse(
      calls.get(message.tool_call_id),
    );
    if (args.success) for (const type of args.data.types) described.add(type);
  }
  return described;
}

/** This turn in the session: `${sessionId}|${runId}`. */
const runKeyOf = (ctx: RuntimeContext) =>
  `${ctx.session.id}|${ctx.session.runId ?? ''}`;

/**
 * Turns whose described types could not be stored: they fall back to every
 * type's fields and no refusal (a store failure must not make chain cards
 * unusable). Bounded; the oldest turn is dropped first.
 */
const UNSTORED_TURNS_MAX = 256;
const unstoredTurns = new Set<string>();

/**
 * The types this call may use (and whose fields the model is given), by
 * one rule: described in the history this call sees (`messages`), or
 * stored by an earlier run of the session. A type the current run stored
 * counts only once its `describe_chain_messages` result is in that history,
 * so a describe made in the same model response as the request (a parallel
 * call) never lets the request through, whichever finishes first. Null when
 * the session cannot remember (no store or session, or the store failed):
 * every type then carries its fields and none is refused.
 */
async function describedChainTxTypes(
  ctx: RuntimeContext,
  messages: readonly BaseMessage[],
): Promise<ChainTxMessageType[] | null> {
  if (!ctx.kv || !ctx.session.id || unstoredTurns.has(runKeyOf(ctx)))
    return null;
  let stored: Partial<Record<ChainTxMessageType, string>>;
  try {
    stored = describedRecord(
      await ctx.kv.get(DESCRIBED_NAMESPACE, ctx.session.id),
    );
  } catch (error) {
    ctx.logger.warn(
      `[hub-actions] described chain message types unreadable; every type keeps its fields: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  const inHistory = describedInHistory(messages);
  const runId = ctx.session.runId ?? '';
  return CHAIN_TX_MESSAGE_TYPES.filter(
    (type) =>
      inHistory.has(type) ||
      (stored[type] !== undefined && stored[type] !== runId),
  );
}

/** Records the described types; a type keeps the run that first described it. */
async function rememberDescribed(
  ctx: RuntimeContext,
  types: readonly ChainTxMessageType[],
): Promise<void> {
  if (!ctx.kv || !ctx.session.id) return;
  const runId = ctx.session.runId ?? '';
  try {
    await ctx.kv.update(
      DESCRIBED_NAMESPACE,
      ctx.session.id,
      (current) => ({
        ...Object.fromEntries(types.map((type) => [type, runId])),
        ...describedRecord(current),
      }),
      { idleTtlMs: DESCRIBED_IDLE_TTL_MS, maxEntries: DESCRIBED_MAX_SESSIONS },
    );
  } catch (error) {
    ctx.logger.warn(
      `[hub-actions] described chain message types not stored; this turn gives every type's fields: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (unstoredTurns.size >= UNSTORED_TURNS_MAX)
      unstoredTurns.delete(unstoredTurns.values().next().value!);
    unstoredTurns.add(runKeyOf(ctx));
  }
}

/**
 * The account's chain types for a turn, read once (by the request tool and
 * then reused by `chainTxFieldsMiddleware` for every model call).
 */
const turnChainTxTypes = new WeakMap<
  RuntimeContext,
  Promise<readonly ChainTxMessageType[]>
>();
function chainTxTypesForTurn(
  ctx: RuntimeContext,
): Promise<readonly ChainTxMessageType[]> {
  let types = turnChainTxTypes.get(ctx);
  if (!types) {
    types = availableChainTxTypes(ctx);
    turnChainTxTypes.set(ctx, types);
  }
  return types;
}

/** The function definition of a request tool, per description, built once. */
const toolDefinitions = new WeakMap<
  PluginTool,
  Map<string, Record<string, unknown>>
>();
function definitionOf(
  pluginTool: PluginTool,
  description: string,
): Record<string, unknown> {
  let byDescription = toolDefinitions.get(pluginTool);
  if (!byDescription) {
    byDescription = new Map();
    toolDefinitions.set(pluginTool, byDescription);
  }
  let definition = byDescription.get(description);
  if (!definition) {
    const { type, function: fn } = convertToOpenAITool(
      tool(async () => '', {
        name: pluginTool.name,
        description,
        schema: pluginTool.schema,
      }),
    );
    // A plain object (a server-tool definition to LangChain), not a tool
    // instance: LangChain refuses a new instance of a registered tool.
    definition = { type, function: fn };
    byDescription.set(description, definition);
  }
  return definition;
}

/**
 * The per-turn tool is built before the turn's first model call, so a type
 * described during the turn would reach the next model call without its
 * fields, and a provider drops fields its schema does not declare (the
 * 0.29.0 failure). Before each model call this gives the model the request
 * tool for what is described by then (`describedChainTxTypes` over the
 * call's messages), as its function definition with the registered tool's
 * name and description; the registered tool, whose schema accepts the
 * fields of every type, still runs the call. A tool the capability gate
 * hid is not in the request, so nothing is added; a failure to read the
 * store leaves the request as it is.
 */
function chainTxFieldsMiddleware(ctx: RuntimeContext) {
  return createMiddleware({
    name: 'HubActionsChainTxFieldsMiddleware',
    wrapModelCall: async (request, handler) => {
      const index = request.tools.findIndex(
        (entry) => entry.name === 'request_chain_transaction',
      );
      const registered = request.tools[index];
      if (!registered || typeof registered.description !== 'string')
        return handler(request);
      const described = await describedChainTxTypes(ctx, request.messages);
      if (!described) return handler(request);
      const current = chainTransactionTool(
        await chainTxTypesForTurn(ctx),
        described,
      );
      if (!current) return handler(request);
      const tools = [...request.tools];
      tools[index] = definitionOf(current, registered.description);
      return handler({ ...request, tools });
    },
  });
}
const chainTransactionTools = new Map<string, PluginTool>();

/** The request tool as the whole catalogue gives it (no account capabilities). */
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
  'Read the full rules of chain-transaction message types before using them in request_chain_transaction: every field with its meaning, format and limits, what the runtime fills, and chain caveats. Ask only for the types you need: request_chain_transaction takes only types described in this conversation, and gives their fields from the next call on. Also returns `availableTypes`: the types this account may use.';

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
  schema: ReturnType<typeof chainTransactionSchemaFor>,
  input: unknown,
  ctx: RuntimeContext,
): Promise<HubActionRequestResult | ToolMessage> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return chainTxShapeRefusal(issuesOf(parsed.error));
  const described = await describedChainTxTypes(ctx, ctx.history.messages);
  if (described) {
    const unread = [
      ...new Set(
        parsed.data.messages
          .flatMap((message) => [
            chainTxTypeOf(message),
            ...groupActionTypesOf(message),
          ])
          .filter(
            (type): type is ChainTxMessageType =>
              type !== null && !described.includes(type),
          ),
      ),
    ];
    if (unread.length)
      // Not run, and not a failure: the repetition guard lets the same
      // call through once the rules are read.
      return toolNotRunMessage({
        toolCallId: ctx.toolCallId ?? '',
        name: 'request_chain_transaction',
        content: `For you, not the person: nothing was sent and nothing is wrong. Before a card with ${unread.map((type) => `\`${type}\``).join(', ')}, read the rules: call describe_chain_messages with types ${JSON.stringify(unread)}, then call request_chain_transaction again with exactly the fields it lists. Do not mention this step to the person.`,
      });
  }
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
  // A group step is a chain of reads in Auth Hub and names a new
  // proposal's number on its receipt: it goes alone on its card (the
  // protocol refuses `messages` otherwise).
  if (
    messages.length > 1 &&
    messages.some((message) => {
      const type = chainTxTypeOf(message);
      return type !== null && GROUP_STEP_TYPES.includes(type);
    })
  )
    issues.push(
      'messages: a group step (a group vote, carrying out or closing a group proposal, a new group proposal) goes alone on its card; prepare the other messages on another card',
    );
  messages.forEach((message, index) => {
    const type = chainTxTypeOf(message);
    if (!type) {
      issues.push(`messages[${index}].type: not a known message type`);
      return;
    }
    const result = CHAIN_TX_CATALOG[type].schema.safeParse(message);
    if (result.success) checked.push(chainTxMessageInput(result.data));
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

const GROUP_STEP_TYPES: readonly ChainTxMessageType[] =
  CHAIN_TX_GROUP_MESSAGE_TYPES;

/**
 * The action types a new group proposal holds (each a type a group may
 * do): their rules are read like a top-level message's before the card.
 * Anything else is left to the message's own check.
 */
function groupActionTypesOf(message: unknown): ChainTxMessageType[] {
  if (
    chainTxTypeOf(message) !== 'daodao.proposal.create' ||
    typeof message !== 'object' ||
    message === null ||
    !('actions' in message) ||
    !Array.isArray(message.actions)
  )
    return [];
  return message.actions
    .map(chainTxTypeOf)
    .filter(
      (type): type is ChainTxMessageType =>
        type !== null && GROUP_ACTION_TYPES.some((allowed) => allowed === type),
    );
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
 * `chainTx.messageTypes`, which follow the protocol level the Hub speaks
 * with this runtime (level 5: the four 0.6.0 types; 6: 33; 7: all 37, the
 * four group steps included). None when chain transactions cannot be used
 * here: not a channel turn, Hub actions off, chain transactions off for the
 * account, or capabilities that cannot be read (the owner object answers its
 * last good capabilities while a read fails, and does not retry a failed
 * read for 30 s, so this never holds a turn for long).
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
    return [];
  let chainTx;
  try {
    chainTx = (await ctx.hubActions.capabilities({ turn: true })).chainTx;
  } catch (error) {
    ctx.logger.warn(
      `[hub-actions] capabilities unavailable, no chain transaction types this turn: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
  return CHAIN_TX_MESSAGE_TYPES.filter((type) =>
    chainTx?.messageTypes.includes(type),
  );
}

/**
 * A new group proposal's action as describe_chain_messages lists it: the
 * types it may be, each with its own fields (described on its own), so one
 * description does not repeat fourteen others.
 */
const GROUP_ACTION_FIELDS = {
  type: 'object',
  description:
    'One message of the types listed in `type`, with exactly that type’s fields (describe_chain_messages that type); the group’s own account is its actor.',
  properties: { type: { type: 'string', enum: [...GROUP_ACTION_TYPES] } },
  required: ['type'],
};

/** Each type's fields as JSON Schema, built once. */
const catalogueFields = new Map<ChainTxMessageType, unknown>();
function fieldsOf(type: ChainTxMessageType): unknown {
  let fields = catalogueFields.get(type);
  if (fields === undefined) {
    const { properties, required } = z.toJSONSchema(
      CHAIN_TX_CATALOG[type].schema,
      {
        override: ({ zodSchema, jsonSchema }) => {
          if (zodSchema !== GROUP_ACTION_SCHEMA) return;
          for (const key of Object.keys(jsonSchema))
            Reflect.deleteProperty(jsonSchema, key);
          Object.assign(jsonSchema, GROUP_ACTION_FIELDS);
        },
      },
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
  await rememberDescribed(ctx, parsed.data.types);
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

/**
 * What a `cancelled` outcome means. Auth Hub withdraws a card when the
 * person cancels it, and also on its own: a chain transaction whose details
 * changed on chain after the review (`409 review_changed`, reason
 * `chain_changed`, shown on the review page only). The oracle gets
 * `cancelled` either way, so the model must not say who withdrew it.
 */
export const CANCELLED_MEANING =
  'Withdrawn before anything was sent: nothing happened on chain. The person may have cancelled it, or Auth Hub withdrew it because something it depended on changed after the review; do not say the person cancelled it. If they still want it, offer to prepare a fresh one.';

/**
 * A carried-out group proposal whose actions failed: the transaction
 * succeeds (code 0) even then, and the network marks the proposal failed
 * for good, so the receipt's `groupActions` is the only sign.
 */
export const GROUP_ACTIONS_FAILED_MEANING =
  'The transaction went through, but the proposal’s actions failed: nothing in the proposal happened, the network has marked it failed for good and it can’t be carried out again. The network fee was used unless a fee grant covered it. Never say it is done; tell the person plainly.';

/** A carried-out group proposal whose transaction did not show whether its actions ran. */
export const GROUP_ACTIONS_UNKNOWN_MEANING =
  'The transaction went through, but Auth Hub could not tell from it whether the proposal’s actions happened. Check the proposal’s status with chain_lookup dao_proposals (executed: they happened; execution_failed: they did not) before saying anything about it; never say it is done until then.';

/** A new group proposal whose number Auth Hub could not read from the transaction. */
export const PROPOSAL_NUMBER_UNKNOWN_MEANING =
  'The new proposal was made, but Auth Hub could not read its number from the transaction. Find the new proposal with chain_lookup dao_proposals (the group’s newest) before naming it; never guess its number.';

/**
 * What an outcome means beyond its fields, for the model: a withdrawn card,
 * a carried-out proposal whose actions failed or may have, a new proposal
 * without its number. Undefined for anything else.
 */
export function outcomeMeaning(
  outcome: ActionOutcomeV1 | null,
): string | undefined {
  if (!outcome) return undefined;
  if (outcome.status === 'cancelled') return CANCELLED_MEANING;
  const receipt = outcome.receipt;
  if (receipt?.kind !== 'ixo.chain.tx.v1') return undefined;
  for (const step of receipt.steps) {
    if (step.type === 'daodao.proposal.execute') {
      if (step.groupActions === 'failed') return GROUP_ACTIONS_FAILED_MEANING;
      if (step.groupActions === 'unknown') return GROUP_ACTIONS_UNKNOWN_MEANING;
    }
    if (step.type === 'daodao.proposal.create' && step.proposalId === null)
      return PROPOSAL_NUMBER_UNKNOWN_MEANING;
  }
  return undefined;
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
    const meaning = outcomeMeaning(read.outcome);
    return {
      status: 'known',
      reviewStatus: read.reviewStatus,
      operationStatus: read.operationStatus,
      outcome: modelOutcome(read.outcome),
      ...(read.summary ? { summary: read.summary } : {}),
      ...(meaning ? { meaning } : {}),
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
    'The user asks to stake, unstake or move IXO, claim staking rewards, vote on a network proposal or retire impact tokens.',
    'The user asks to reserve or dispute a claim, create or change a claim collection, give or remove a permission, create or update an entity, or change the links of an identity.',
    'The user asks to vote on a proposal of a group (DAO) they belong to, carry out or close a group proposal, or put a new proposal to a group.',
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
  /**
   * request_chain_transaction is built per turn: its schema names only the
   * message types this account may use (Auth Hub capabilities, cached by
   * the owner object), so 37 types do not reach a model that may use 4.
   */
  override async getRequestTools(ctx: RuntimeContext): Promise<PluginTool[]> {
    const [available, described] = await Promise.all([
      chainTxTypesForTurn(ctx),
      describedChainTxTypes(ctx, ctx.history.messages),
    ]);
    const tool = chainTransactionTool(available, described);
    return tool ? [tool] : [];
  }
  /** Gives each model call the request tool with the fields described so far in the turn. */
  override getRequestMiddlewares(ctx: RuntimeContext): AgentMiddleware[] {
    return [chainTxFieldsMiddleware(ctx)];
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
        name: 'hub_action_status',
        description:
          'Read the verified status of a Hub action already prepared for this owner. Never executes. A `cancelled` outcome was withdrawn before anything was sent, by the person or by Auth Hub (`meaning` says so): never say the person cancelled it. When `meaning` is present, it says what the outcome means for the person (for example a carried-out group proposal whose actions failed): follow it.',
        schema: statusSchema,
        effect: 'read',
        handler: hubActionStatus,
      },
    ];
  }
}
