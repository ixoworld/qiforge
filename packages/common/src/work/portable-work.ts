import { z } from 'zod';

export const PortableWorkScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * Property names a portable definition's `configurationDefaults` may never
 * carry: they name authority, credentials, or execution state, none of which
 * belongs in reusable work. Mirrors `portableWorkDefinition.configurationDefaults
 * .propertyNames` in the Topic Protocol recipe schema; keep the two lists equal.
 */
export const PORTABLE_WORK_RESERVED_CONFIGURATION_KEYS = [
  'principal',
  'owner',
  'actor',
  'did',
  'ucan',
  'authority',
  'authorityProof',
  'authorityProofRef',
  'credential',
  'credentialRef',
  'secret',
  'secretRef',
  'approval',
  'claim',
  'decision',
  'receipt',
  'executionHandle',
  'runId',
  'sessionId',
  'settlementAuthority',
  'paymentAuthorization',
] as const;

const RESERVED_KEYS: ReadonlySet<string> = new Set(
  PORTABLE_WORK_RESERVED_CONFIGURATION_KEYS,
);

const uniqueStrings = z
  .array(z.string().min(1))
  .refine((items) => new Set(items).size === items.length, {
    message: 'Items must be unique',
  });

const PortableWorkConfigurationDefaultsSchema = z
  .record(z.string(), PortableWorkScalarSchema)
  .superRefine((defaults, ctx) => {
    for (const key of Object.keys(defaults)) {
      if (RESERVED_KEYS.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `"${key}" is reserved and cannot appear in portable configuration defaults`,
        });
      }
    }
  });

export const PortableWorkDefinitionSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1).max(160),
    intent: z.string().min(1),
    outcome: z.string().min(1).optional(),
    definitionOfDone: uniqueStrings.optional(),
    rubricRefs: uniqueStrings.optional(),
    suggestedRoles: uniqueStrings.optional(),
    suggestedCapabilities: uniqueStrings.optional(),
    configurationDefaults: PortableWorkConfigurationDefaultsSchema.optional(),
  })
  .strict();

export type PortableWorkScalar = z.infer<typeof PortableWorkScalarSchema>;
export type PortableWorkDefinition = z.infer<
  typeof PortableWorkDefinitionSchema
>;
