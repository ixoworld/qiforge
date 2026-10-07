import { z } from 'zod';

export const NetworkSchema = z.enum(['devnet', 'testnet', 'mainnet']);
export type Network = z.infer<typeof NetworkSchema>;

export const IntegerStringSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, 'Use an integer string with no decimal point');

export const IxoAddressSchema = z
  .string()
  .regex(
    /^ixo1[0-9a-z]{20,80}$/,
    'Expected an IXO bech32 account address beginning with ixo1',
  );

export const IxoDidSchema = z
  .string()
  .regex(
    /^did:ixo:(entity:[a-f0-9]{32}|wasm:ixo1[0-9a-z]{20,80}|ixo1[0-9a-z]{20,80}|[A-Za-z0-9:._#-]+)$/,
    'Expected a did:ixo DID',
  );

export const TimestampSchema = z.union([
  z.iso.datetime({ offset: true }),
  z
    .object({
      seconds: z.union([IntegerStringSchema, z.number().int().nonnegative()]),
      nanos: z.number().int().min(0).max(999999999).optional(),
    })
    .strict(),
]);

/**
 * A protobuf `bytes` field in proto-JSON: standard, padded base64. The Portal
 * decodes it with the SDK's generated `fromJSON` (`bytesFromBase64`), so a hex
 * string or a byte array would reach the wallet as different bytes.
 */
export const Base64BytesSchema = z
  .string()
  .min(1)
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
    'Expected standard padded base64 (proto-JSON bytes)',
  );

export const CoinSchema = z
  .object({
    denom: z.string().min(1),
    amount: IntegerStringSchema,
  })
  .strict();

export const VerificationMethodSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    controller: IxoDidSchema,
    blockchainAccountID: z.string().min(1).optional(),
    publicKeyHex: z
      .string()
      .regex(/^[0-9a-fA-F]+$/)
      .optional(),
    publicKeyMultibase: z.string().min(1).optional(),
    publicKeyBase58: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const materialFields = [
      'blockchainAccountID',
      'publicKeyHex',
      'publicKeyMultibase',
      'publicKeyBase58',
    ] as const;
    const present = materialFields.filter(
      (field) => value[field] !== undefined,
    );
    if (present.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message:
          'VerificationMethod must set exactly one verification material field',
      });
    }
  });

export const VerificationSchema = z
  .object({
    relationships: z.array(z.string().min(1)).min(1),
    method: VerificationMethodSchema,
    context: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const ServiceSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    serviceEndpoint: z.string().min(1),
  })
  .strict();

export const ContextSchema = z
  .object({
    key: z.string().min(1),
    val: z.string().min(1),
  })
  .strict();

export const LinkedResourceSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    description: z.string().optional(),
    mediaType: z.string().optional(),
    serviceEndpoint: z.string().min(1),
    proof: z.string().optional(),
    encrypted: z.string().optional(),
    right: z.string().optional(),
  })
  .strict();

export const LinkedEntitySchema = z
  .object({
    id: IxoDidSchema,
    type: z.string().min(1),
    relationship: z.string().min(1),
    service: z.string().optional(),
  })
  .strict();

export const LinkedClaimSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    description: z.string().optional(),
    serviceEndpoint: z.string().optional(),
    proof: z.string().optional(),
    encrypted: z.string().optional(),
    right: z.string().optional(),
  })
  .strict();

export const AccordedRightSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    mechanism: z.string().optional(),
    message: z.string().optional(),
    service: z.string().optional(),
  })
  .strict();

/** A protobuf `uint64`: an integer string, or a non-negative integer. */
export const UintSchema = z.union([
  IntegerStringSchema,
  z.number().int().nonnegative(),
]);

const MsgTypeUrlSchema = z
  .string()
  .regex(
    /^\/[A-Za-z0-9.]+\.Msg[A-Za-z0-9]+$/,
    'Expected an IXO/Cosmos Msg typeUrl',
  );

/**
 * The authorizations an entity-account grant may carry, as structured JSON
 * (not an opaque `Any`): the Portal handler encodes the chosen one into the
 * grant's `google.protobuf.Any` with the SDK codec. Anything else is refused.
 */
export const GenericAuthorizationSchema = z
  .object({
    typeUrl: z.literal('/cosmos.authz.v1beta1.GenericAuthorization'),
    value: z.object({ msg: MsgTypeUrlSchema }).strict(),
  })
  .strict();

export const SendAuthorizationSchema = z
  .object({
    typeUrl: z.literal('/cosmos.bank.v1beta1.SendAuthorization'),
    value: z
      .object({
        spendLimit: z.array(CoinSchema).min(1),
        allowList: z.array(IxoAddressSchema).optional(),
      })
      .strict(),
  })
  .strict();

export const AuthorizationSchema = z.discriminatedUnion('typeUrl', [
  GenericAuthorizationSchema,
  SendAuthorizationSchema,
]);

export const AUTHORIZATION_TYPE_URLS = [
  '/cosmos.authz.v1beta1.GenericAuthorization',
  '/cosmos.bank.v1beta1.SendAuthorization',
] as const;

export const AuthzGrantSchema = z
  .object({
    authorization: AuthorizationSchema,
    expiration: TimestampSchema.optional(),
  })
  .strict();

export const TokenBatchSchema = z
  .object({
    id: z.string().min(1),
    amount: IntegerStringSchema,
  })
  .strict();

/** `google.protobuf.Duration` in proto-JSON as the SDK reads it. */
export const DurationSchema = z
  .object({
    seconds: UintSchema,
    nanos: z.number().int().min(0).max(999_999_999).optional(),
  })
  .strict();

export const CW20PaymentSchema = z
  .object({
    address: IxoAddressSchema,
    amount: UintSchema,
  })
  .strict();

export const CW1155PaymentSchema = z
  .object({
    address: IxoAddressSchema,
    tokenId: z.array(z.string().min(1)).min(1),
    amount: UintSchema,
  })
  .strict();

export const Contract1155PaymentSchema = z
  .object({
    address: IxoAddressSchema,
    tokenId: z.string().min(1),
    // uint32 in the proto
    amount: z.number().int().nonnegative().max(4_294_967_295),
  })
  .strict();

export const PaymentSchema = z
  .object({
    account: IxoAddressSchema,
    amount: z.array(CoinSchema).optional(),
    // The proto field keeps its underscore in proto-JSON.
    contract_1155Payment: Contract1155PaymentSchema.optional(),
    timeoutNs: DurationSchema.optional(),
    cw20Payment: z.array(CW20PaymentSchema).optional(),
    isOraclePayment: z.boolean().optional(),
    cw1155Payment: z.array(CW1155PaymentSchema).optional(),
  })
  .strict();

export const PaymentsSchema = z
  .object({
    submission: PaymentSchema.optional(),
    evaluation: PaymentSchema.optional(),
    approval: PaymentSchema.optional(),
    rejection: PaymentSchema.optional(),
  })
  .strict();

export const AdjudicationDidSchema = z
  .object({
    did: IxoDidSchema,
    rewardPercentage: z
      .string()
      .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/, 'Expected a decimal string'),
  })
  .strict();

export const DisputeDataSchema = z
  .object({
    uri: z.string().min(1),
    type: z.string().min(1),
    proof: z.string().min(1),
    encrypted: z.boolean().optional(),
  })
  .strict();

export const TokenDataSchema = z
  .object({
    uri: z.string().min(1),
    encrypted: z.boolean().optional(),
    proof: z.string().min(1),
    type: z.string().min(1),
    id: z.string().min(1),
  })
  .strict();

export const MintBatchSchema = z
  .object({
    name: z.string().min(1),
    index: z.string().min(1),
    amount: IntegerStringSchema,
    collection: z.string().min(1),
    tokenData: z.array(TokenDataSchema).optional(),
  })
  .strict();

/**
 * Canonical Cosmos `EncodeObject` — `{ typeUrl, value }`. The proto-JSON `value`
 * is what crosses to the frontend; the Portal `sign_transaction` handler runs it
 * through the IXO SDK's `fromJSON` before signing.
 */
export const ITrxMsgSchema = z
  .object({
    typeUrl: z
      .string()
      .regex(
        /^\/[A-Za-z0-9.]+\.Msg[A-Za-z0-9]+$/,
        'Expected an IXO/Cosmos Msg typeUrl',
      ),
    value: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ITrxMsg = z.infer<typeof ITrxMsgSchema>;

export const RiskConfirmationSchema = z
  .object({
    confirmed: z.literal(true),
    acceptedRisks: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type RiskConfirmation = z.infer<typeof RiskConfirmationSchema>;

/**
 * A testnet signing the oracle itself recorded: the hash the wallet returned
 * and the id of the oracle's record of it (returned with the `signed` result).
 * This package only checks the shape; the oracle verifies the record — that
 * it exists for this user and was made for the same message — before it
 * dispatches a mainnet draft.
 */
export const TestnetReceiptSchema = z
  .object({
    transactionHash: z.string().regex(/^[0-9A-Fa-f]{32,128}$/),
    receiptId: z.string().min(1),
  })
  .strict();

export type TestnetReceipt = z.infer<typeof TestnetReceiptSchema>;

export const TransactionDraftSchema = z
  .object({
    input: z.string().optional(),
    command: z.string().optional(),
    messageType: z.string().optional(),
    action: z.string().optional(),
    typeUrl: z.string().optional(),
    value: z.record(z.string(), z.unknown()).default({}),
    memo: z.string().optional(),
    network: NetworkSchema.default('testnet'),
    riskConfirmation: RiskConfirmationSchema.optional(),
    testnetReceipt: TestnetReceiptSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      !value.input &&
      !value.command &&
      (!value.messageType || !value.action) &&
      !value.typeUrl
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provide input, command, messageType/action, or typeUrl',
      });
    }
  });

export type TransactionDraft = z.infer<typeof TransactionDraftSchema>;

/**
 * The most messages one batch may carry. A batch is signed as one wallet
 * transaction the user reviews as a whole, so the bound keeps that review
 * (and the transaction's size) small. It is a review bound, not a gas
 * figure: a batch within it can still run out of gas on chain.
 */
export const MAX_BATCH_MESSAGES = 16;

/** The longest batch summary: one paragraph the wallet prompt can show. */
export const MAX_BATCH_SUMMARY_LENGTH = 1000;

/**
 * A batch: several catalogued proto-JSON messages signed together in one
 * wallet transaction (all or nothing on chain). Built by a caller that
 * composes the messages itself (the POD creator's chain gateway), not routed
 * from conversation — a conversational draft stays one message
 * (`TransactionDraftSchema`). There is no testnet receipt: each caller owns
 * its mainnet policy.
 */
export const TransactionBatchSchema = z
  .object({
    messages: z.array(ITrxMsgSchema).min(1).max(MAX_BATCH_MESSAGES),
    /** What the batch does as a whole, for the user reviewing it. */
    summary: z.string().trim().min(1).max(MAX_BATCH_SUMMARY_LENGTH),
    memo: z.string().optional(),
    network: NetworkSchema.default('testnet'),
    riskConfirmation: RiskConfirmationSchema.optional(),
  })
  .strict();

export type TransactionBatch = z.infer<typeof TransactionBatchSchema>;

/**
 * The draft as a tool's input schema: the same fields, described for the
 * model, with no defaults, refinements or strictness. A tool host parses its
 * input with this before the handler runs; the handler then applies
 * `TransactionDraftSchema` itself, so a malformed draft comes back as a
 * structured validation result instead of a host-level parsing error.
 * Unknown keys are kept so the strict parse can name them.
 */
export const TransactionDraftInputSchema = z.looseObject({
  input: z
    .string()
    .optional()
    .describe('Free-text intent, e.g. "retire 10 credits"'),
  command: z
    .string()
    .optional()
    .describe('Slash command: /ixo {message-type} {message-action}'),
  messageType: z
    .string()
    .optional()
    .describe('Module, with action: entity, iid, claims, token, smart-account'),
  action: z
    .string()
    .optional()
    .describe('Route action, with messageType, e.g. create, transfer'),
  typeUrl: z
    .string()
    .optional()
    .describe('Msg typeUrl, e.g. /ixo.entity.v1beta1.MsgCreateEntity'),
  value: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Msg fields in proto-JSON (camelCase names, integer amounts as strings, bytes as base64)',
    ),
  memo: z.string().optional(),
  network: NetworkSchema.optional().describe('Defaults to testnet'),
  riskConfirmation: z
    .object({
      confirmed: z.boolean(),
      acceptedRisks: z.array(z.string()),
    })
    .optional()
    .describe('The risks the user explicitly accepted, quoted'),
  testnetReceipt: z
    .object({
      transactionHash: z.string(),
      receiptId: z.string(),
    })
    .optional()
    .describe(
      'Mainnet only: the testnetReceipt a signed testnet run of the same transaction returned',
    ),
});

/**
 * Field kinds reference the actual protobuf field types of the supported
 * IXO `Msg`s (verified against `@ixo/impactxclient-sdk`). Singular `*` kinds
 * map to a single nested message; `*Array` kinds map to a repeated field.
 * Every nested message has a strict schema whose keys the catalog test
 * checks against the SDK codec.
 */
export type FieldKind =
  | 'string'
  | 'stringArray'
  | 'did'
  | 'didArray'
  | 'address'
  | 'bool'
  | 'int'
  | 'uint'
  | 'timestamp'
  | 'coinArray'
  | 'bytes'
  | 'duration'
  | 'payments'
  | 'disputeData'
  | 'cw20PaymentArray'
  | 'cw1155PaymentArray'
  | 'adjudicationDidArray'
  | 'mintBatchArray'
  | 'verification'
  | 'verificationArray'
  | 'service'
  | 'serviceArray'
  | 'context'
  | 'contextArray'
  | 'linkedResource'
  | 'linkedResourceArray'
  | 'linkedEntity'
  | 'linkedEntityArray'
  | 'linkedClaim'
  | 'linkedClaimArray'
  | 'accordedRight'
  | 'accordedRightArray'
  | 'tokenBatchArray'
  | 'authzGrant';

export function schemaForFieldKind(kind: FieldKind): z.ZodTypeAny {
  switch (kind) {
    case 'string':
      return z.string().min(1);
    case 'stringArray':
      return z.array(z.string().min(1));
    case 'did':
      return IxoDidSchema;
    case 'didArray':
      return z.array(IxoDidSchema);
    case 'address':
      return IxoAddressSchema;
    case 'bool':
      return z.boolean();
    case 'int':
      return z.number().int();
    case 'uint':
      return UintSchema;
    case 'timestamp':
      return TimestampSchema;
    case 'coinArray':
      return z.array(CoinSchema);
    case 'bytes':
      return Base64BytesSchema;
    case 'verification':
      return VerificationSchema;
    case 'verificationArray':
      return z.array(VerificationSchema).min(1);
    case 'service':
      return ServiceSchema;
    case 'serviceArray':
      return z.array(ServiceSchema);
    case 'context':
      return ContextSchema;
    case 'contextArray':
      return z.array(ContextSchema);
    case 'linkedResource':
      return LinkedResourceSchema;
    case 'linkedResourceArray':
      return z.array(LinkedResourceSchema);
    case 'linkedEntity':
      return LinkedEntitySchema;
    case 'linkedEntityArray':
      return z.array(LinkedEntitySchema);
    case 'linkedClaim':
      return LinkedClaimSchema;
    case 'linkedClaimArray':
      return z.array(LinkedClaimSchema);
    case 'accordedRight':
      return AccordedRightSchema;
    case 'accordedRightArray':
      return z.array(AccordedRightSchema);
    case 'tokenBatchArray':
      return z.array(TokenBatchSchema).min(1);
    case 'authzGrant':
      return AuthzGrantSchema;
    case 'duration':
      return DurationSchema;
    case 'payments':
      return PaymentsSchema;
    case 'disputeData':
      return DisputeDataSchema;
    case 'cw20PaymentArray':
      return z.array(CW20PaymentSchema);
    case 'cw1155PaymentArray':
      return z.array(CW1155PaymentSchema);
    case 'adjudicationDidArray':
      return z.array(AdjudicationDidSchema);
    case 'mintBatchArray':
      return z.array(MintBatchSchema).min(1);
    default:
      return z.never();
  }
}
