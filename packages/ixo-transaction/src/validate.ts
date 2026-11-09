import { z } from 'zod';

import {
  findMessageByRoute,
  findMessageForValue,
  findMessagesByTypeUrl,
  type FieldSpec,
  type MessageSpec,
  type RiskLevel,
} from './catalog.js';
import {
  DAODAO_EXECUTE_ACTIONS,
  WASM_INSTANTIATE_TYPE_URL,
  daoDaoProposalActions,
  parseDaoDaoExecuteValue,
  parseDaoDaoInstantiateValue,
} from './daodao-schemas.js';
import { resolveIntent, type IntentResult } from './intent.js';
import {
  ITrxMsgSchema,
  TransactionBatchSchema,
  TransactionDraftSchema,
  schemaForFieldKind,
  type ITrxMsg,
  type Network,
  type RiskConfirmation,
  type TransactionBatch,
  type TransactionDraft,
} from './schemas.js';

export type ValidatedTransaction = {
  intent: IntentResult;
  message: ITrxMsg;
  risks: string[];
  riskLevel: MessageSpec['riskLevel'];
  requiresConfirmation: boolean;
  network: TransactionDraft['network'];
  memo?: string;
};

export type ValidationOptions = {
  /** Enforce the risk gate (signing). Validation alone only reports the risks. */
  requireRiskConfirmation?: boolean;
  /**
   * Whether mainnet drafts may pass at all. Off unless the caller (the
   * oracle operator's configuration) turns it on; when on, a mainnet draft
   * still needs a `testnetReceipt`, which the caller must verify against its
   * own record of the testnet signing — this package only checks its shape.
   */
  allowMainnet?: boolean;
};

/**
 * One readable line for a validation failure: each Zod issue as
 * `path: message`, or the error's own message.
 */
export function describeValidationError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) =>
        issue.path.length > 0
          ? `${issue.path.join('.')}: ${issue.message}`
          : issue.message,
      )
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

function buildValueSchema(
  fields: readonly FieldSpec[],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    const schema = schemaForFieldKind(field.kind);
    shape[field.name] = field.required ? schema : schema.optional();
  }
  return z.object(shape).strict();
}

function assertTypeUrlConflict(
  draftTypeUrl: string | undefined,
  resolvedTypeUrl: string,
): void {
  if (draftTypeUrl && draftTypeUrl !== resolvedTypeUrl) {
    throw new Error(
      `typeUrl conflict: draft provided ${draftTypeUrl}, but intent resolves to ${resolvedTypeUrl}`,
    );
  }
}

function assertMainnetGate(
  draft: TransactionDraft,
  options: ValidationOptions,
): void {
  if (draft.network !== 'mainnet') return;
  if (options.allowMainnet !== true) {
    throw new Error(
      'Mainnet transactions are disabled for this oracle: prepare the transaction on testnet instead',
    );
  }
  if (draft.testnetReceipt) return;
  throw new Error(
    'Mainnet draft blocked: sign the same transaction on testnet first and pass the testnetReceipt that signing returned',
  );
}

function isRisky(spec: MessageSpec): boolean {
  return spec.riskLevel !== 'low' || spec.risks.length > 0;
}

/**
 * A risk's text as compared when the user's acceptance is checked: the same
 * words, with typographic quotes and apostrophes read as their plain forms,
 * Unicode compatibility forms folded and runs of whitespace as one space. A
 * model quoting `group's` for `group’s` quotes the risk; it never makes a
 * different risk match.
 */
export function riskTextKey(risk: string): string {
  return risk
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The risk gate: when the transaction is risky and the caller signs
 * (`requireRiskConfirmation`), every one of `risks` must be accepted word for
 * word (as `riskTextKey` compares them) and `confirmed` must be true.
 */
function assertRiskGate(
  subject: string,
  risky: boolean,
  risks: readonly string[],
  confirmation: RiskConfirmation | undefined,
  options: ValidationOptions,
): void {
  if (!risky || !options.requireRiskConfirmation) return;
  const accepted = new Set(
    (confirmation?.acceptedRisks ?? []).map(riskTextKey),
  );
  const missing = risks.filter((risk) => !accepted.has(riskTextKey(risk)));
  if (confirmation?.confirmed === true && missing.length === 0) return;
  throw new Error(
    `Risk confirmation required before signing ${subject}: the user must accept, word for word, ${missing
      .map((risk) => JSON.stringify(risk))
      .join(', ')}`,
  );
}

/** What a message is checked against beyond its own fields. */
export type MessageValidationContext = {
  /**
   * The network the message is for. A DAO DAO group is refused without it:
   * its code ids are the network's.
   */
  network?: Network;
};

function requireSpec(message: ITrxMsg): MessageSpec {
  const spec = findMessageForValue(message);
  if (spec) return spec;
  if (findMessagesByTypeUrl(message.typeUrl).length > 0) {
    throw new Error(
      `${message.typeUrl} here is only a DAO DAO step: msg must have exactly one of ${DAODAO_EXECUTE_ACTIONS.join(', ')}`,
    );
  }
  throw new Error(
    `Unsupported message typeUrl ${message.typeUrl}: not in the IXO transaction catalog`,
  );
}

/**
 * The value of a message of the route, strictly parsed: exactly its fields,
 * each of its kind; a DAO DAO route's value exactly its one shape.
 */
function parseValue(
  spec: MessageSpec,
  value: unknown,
  context: MessageValidationContext,
): Record<string, unknown> {
  if (spec.module !== 'daodao') {
    return buildValueSchema(spec.fields).parse(value);
  }
  if (spec.typeUrl === WASM_INSTANTIATE_TYPE_URL) {
    return parseDaoDaoInstantiateValue(value, context.network);
  }
  const action = DAODAO_EXECUTE_ACTIONS.find((step) => step === spec.action);
  if (action === undefined) {
    throw new Error(`No DAO DAO shape for the route ${spec.action}`);
  }
  return parseDaoDaoExecuteValue(action, value, {
    actionProblem: (message) => {
      try {
        validateMessage(message, context);
        return undefined;
      } catch (error) {
        return describeValidationError(error);
      }
    },
  });
}

/**
 * The catalog entries whose risks a validated message carries: its own, then
 * each action a DAO DAO proposal holds (the group's own account does them if
 * it passes), so a proposal that would move the group's funds discloses that
 * move's risks and level, not only the proposal's.
 */
function disclosedSpecs(spec: MessageSpec, message: ITrxMsg): MessageSpec[] {
  return [spec, ...daoDaoProposalActions(message).map(requireSpec)];
}

const uniqueRisks = (specs: readonly MessageSpec[]): string[] => [
  ...new Set(specs.flatMap((spec) => spec.risks)),
];

function validateWithSpec(
  input: unknown,
  context: MessageValidationContext,
): { message: ITrxMsg; spec: MessageSpec } {
  const message = ITrxMsgSchema.parse(input);
  const spec = requireSpec(message);
  return {
    message: {
      typeUrl: spec.typeUrl,
      value: parseValue(spec, message.value, context),
    },
    spec,
  };
}

/**
 * Strictly validate one proto-JSON message against the catalog: a known
 * typeUrl and exactly its fields, each of its kind (a DAO DAO message:
 * exactly one of its shapes, a group with the network's code ids). The
 * Portal handler runs this on every message it is asked to sign.
 */
export function validateMessage(
  input: unknown,
  context: MessageValidationContext = {},
): ITrxMsg {
  return validateWithSpec(input, context).message;
}

const RISK_ORDER: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical'];

/** The highest of the levels (`low` for none). */
function highestRiskLevel(levels: readonly RiskLevel[]): RiskLevel {
  return levels.reduce<RiskLevel>(
    (highest, level) =>
      RISK_ORDER.indexOf(level) > RISK_ORDER.indexOf(highest) ? level : highest,
    'low',
  );
}

/** One message of a validated batch, as its catalog entry names it. */
export type BatchMessageRoute = Pick<
  MessageSpec,
  'module' | 'action' | 'messageName' | 'typeUrl'
>;

export type ValidatedTransactionBatch = {
  /** Every message, validated and canonicalised, in the batch's order. */
  messages: ITrxMsg[];
  /** The catalog route of each message, in the same order. */
  routes: BatchMessageRoute[];
  summary: string;
  /**
   * Every message's risks, each once, in message order; a DAO DAO proposal's
   * own, then those of each action it holds.
   */
  risks: string[];
  /** The highest risk level of any message or proposal action. */
  riskLevel: RiskLevel;
  /** True when any message or proposal action is risky. */
  requiresConfirmation: boolean;
  network: TransactionBatch['network'];
  memo?: string;
};

/**
 * Strictly validate a batch — several catalogued messages signed together in
 * one wallet transaction. Every message passes the same check as a single
 * message (`validateMessage`); the risks are every message's risks (a DAO
 * DAO proposal's include those of each action it holds) and the level is the
 * highest of them. Mainnet needs `allowMainnet`; a batch carries
 * no testnet receipt (each caller owns its mainnet policy). With
 * `requireRiskConfirmation`, every risk must be accepted word for word.
 * Throws on the first failure.
 */
export function validateTransactionBatch(
  input: unknown,
  options: ValidationOptions = {},
): ValidatedTransactionBatch {
  const batch = TransactionBatchSchema.parse(input);
  if (batch.network === 'mainnet' && options.allowMainnet !== true) {
    throw new Error(
      'Mainnet transactions are disabled for this oracle: prepare the transaction on testnet instead',
    );
  }
  const validated = batch.messages.map((message) =>
    validateWithSpec(message, { network: batch.network }),
  );
  const specs = validated.map(({ spec }) => spec);
  const messages = validated.map(({ message }) => message);
  const disclosed = validated.flatMap(({ spec, message }) =>
    disclosedSpecs(spec, message),
  );
  const risks = uniqueRisks(disclosed);
  const requiresConfirmation = disclosed.some(isRisky);
  assertRiskGate(
    `the batch of ${messages.length} message${messages.length === 1 ? '' : 's'}`,
    requiresConfirmation,
    risks,
    batch.riskConfirmation,
    options,
  );
  return {
    messages,
    routes: specs.map(({ module, action, messageName, typeUrl }) => ({
      module,
      action,
      messageName,
      typeUrl,
    })),
    summary: batch.summary,
    risks,
    riskLevel: highestRiskLevel(disclosed.map((spec) => spec.riskLevel)),
    requiresConfirmation,
    network: batch.network,
    memo: batch.memo,
  };
}

/**
 * Resolve, strictly validate, and canonicalize a transaction draft into the
 * proto-JSON `{ typeUrl, value }` the Portal wallet handler decodes. Always
 * enforces the mainnet gate; with `requireRiskConfirmation`, the risk gate
 * too. Throws on the first failure (`describeValidationError` renders it).
 */
export function validateTransactionDraft(
  input: unknown,
  options: ValidationOptions = {},
): ValidatedTransaction {
  const draft = TransactionDraftSchema.parse(input);
  const intent = resolveIntent(draft);
  const spec = findMessageByRoute(intent.module, intent.action);
  if (!spec) {
    throw new Error(
      `Resolved unsupported route: /ixo ${intent.module} ${intent.action}`,
    );
  }

  assertTypeUrlConflict(draft.typeUrl, intent.typeUrl);
  assertMainnetGate(draft, options);
  assertRiskGate(
    spec.messageName,
    isRisky(spec),
    spec.risks,
    draft.riskConfirmation,
    options,
  );

  const value = parseValue(spec, draft.value, { network: draft.network });
  const message = ITrxMsgSchema.parse({ typeUrl: spec.typeUrl, value });
  // A proposal's actions are known once its value is read: their risks join
  // the gate too.
  const disclosed = disclosedSpecs(spec, message);
  const risks = uniqueRisks(disclosed);
  const requiresConfirmation = disclosed.some(isRisky);
  if (disclosed.length > 1) {
    assertRiskGate(
      spec.messageName,
      requiresConfirmation,
      risks,
      draft.riskConfirmation,
      options,
    );
  }

  return {
    intent,
    message,
    risks,
    riskLevel: highestRiskLevel(disclosed.map((s) => s.riskLevel)),
    requiresConfirmation,
    network: draft.network,
    memo: draft.memo,
  };
}
