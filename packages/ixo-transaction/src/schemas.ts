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
  z.string().datetime({ offset: true }),
  z
    .object({
      seconds: z.union([IntegerStringSchema, z.number().int().nonnegative()]),
      nanos: z.number().int().min(0).max(999999999).optional(),
    })
    .strict(),
]);

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
        code: z.ZodIssueCode.custom,
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

export const AnySchema = z
  .object({
    typeUrl: z
      .string()
      .regex(/^\/[A-Za-z0-9.]+$/, 'Expected a protobuf Any typeUrl'),
    value: z.unknown(),
  })
  .strict();

export const AuthzGrantSchema = z
  .object({
    authorization: AnySchema,
    expiration: TimestampSchema.optional(),
  })
  .strict();

export const TokenBatchSchema = z
  .object({
    id: z.string().min(1),
    amount: IntegerStringSchema,
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

export const TestnetReceiptSchema = z
  .object({
    network: z.literal('testnet'),
    transactionHash: z.string().regex(/^[0-9A-Fa-f]{32,128}$/),
    code: z.literal(0),
    height: z
      .union([IntegerStringSchema, z.number().int().nonnegative()])
      .optional(),
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
    overrideMainnet: z.boolean().optional(),
    overrideReason: z.string().min(1).optional(),
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
        code: z.ZodIssueCode.custom,
        message: 'Provide input, command, messageType/action, or typeUrl',
      });
    }
    if (value.overrideMainnet && !value.overrideReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'overrideReason is required when overrideMainnet is true',
      });
    }
  });

export type TransactionDraft = z.infer<typeof TransactionDraftSchema>;

/**
 * Field kinds reference the actual protobuf field types of the supported
 * IXO `Msg`s (verified against `@ixo/impactxclient-sdk`). Singular `*` kinds
 * map to a single nested message; `*Array` kinds map to a repeated field.
 * Deeply-nested protobuf structures we do not model field-by-field use
 * `json`/`jsonArray` (validated as present, encoded by the frontend via the
 * SDK's `fromJSON`).
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
  | 'integerString'
  | 'timestamp'
  | 'coin'
  | 'coinArray'
  | 'json'
  | 'jsonArray'
  | 'bytes'
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
      return z.union([IntegerStringSchema, z.number().int().nonnegative()]);
    case 'integerString':
      return IntegerStringSchema;
    case 'timestamp':
      return TimestampSchema;
    case 'coin':
      return CoinSchema;
    case 'coinArray':
      return z.array(CoinSchema);
    case 'bytes':
      return z.union([
        z.string().min(1),
        z.array(z.number().int().min(0).max(255)),
      ]);
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
    case 'json':
      return z.record(z.string(), z.unknown());
    case 'jsonArray':
      return z.array(z.record(z.string(), z.unknown()));
    default:
      return z.never();
  }
}
