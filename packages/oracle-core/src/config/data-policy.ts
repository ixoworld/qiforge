import { z } from 'zod';

/**
 * Programmatic data-sovereignty policy — the operator-signed document that
 * DECIDES where data may go, enforced by storage, model, telemetry, and
 * egress ports (not by convention). Travels inside the signed config
 * envelope; ports receive its digest so every placement decision is
 * attributable to a specific policy version.
 */
export const dataClassificationSchema = z.enum([
  'public',
  'operational',
  'personal',
  'sensitive',
]);

/** Stores/processors a classification can be admitted to. */
export const dataDestinationSchema = z.enum([
  'matrix',
  'vfs',
  'r2',
  'do-sqlite',
  'telemetry',
  'pooled-inference',
  'byok-inference',
]);

export const dataPolicySchema = z.object({
  schemaVersion: z.literal(1),
  /** Classification applied when a flow has no explicit label. */
  defaultClassification: dataClassificationSchema.default('personal'),
  /** Jurisdictions state may run/persist in (e.g. DO jurisdiction tags). */
  permittedJurisdictions: z.array(z.string().min(1)).default([]),
  /** Named processors (providers, services) permitted to touch data. */
  permittedProcessors: z.array(z.string().min(1)).default([]),
  /** Key custody the stores must honour. */
  encryption: z
    .object({
      mode: z.enum(['operator-managed', 'platform-managed']),
      atRestRequired: z.boolean().default(true),
    })
    .default({ mode: 'operator-managed', atRestRequired: true }),
  retention: z
    .object({
      maxDays: z.number().int().positive().optional(),
      deletionOnRequest: z.boolean().default(true),
      exportOnRequest: z.boolean().default(true),
    })
    .default({ deletionOnRequest: true, exportOnRequest: true }),
  /**
   * Per-classification permissions: which destinations may receive data of
   * each classification, and which model providers may see it. Absent
   * classifications inherit nothing — fail closed.
   */
  placements: z
    .partialRecord(
      dataClassificationSchema,
      z.object({
        destinations: z.array(dataDestinationSchema),
        modelProviders: z.array(z.string().min(1)).default([]),
      }),
    )
    .default({}),
  /** Prompt/response logging + caching rules (AI Gateway logs by default — the adapter must disable unless permitted here). */
  logging: z
    .object({
      promptLogging: z.boolean().default(false),
      responseLogging: z.boolean().default(false),
      inferenceCaching: z.boolean().default(false),
    })
    .default({
      promptLogging: false,
      responseLogging: false,
      inferenceCaching: false,
    }),
});

export type DataPolicy = z.output<typeof dataPolicySchema>;
export type DataClassification = z.output<typeof dataClassificationSchema>;
export type DataDestination = z.output<typeof dataDestinationSchema>;

/**
 * Port-side check: may `classification` data enter `destination` under this
 * policy? Fail-closed — an unlisted classification or destination is a
 * denial, never a default-allow.
 */
export function isPlacementPermitted(
  policy: DataPolicy,
  classification: DataClassification,
  destination: DataDestination,
): boolean {
  const placement = policy.placements[classification];
  if (!placement) return false;
  return placement.destinations.includes(destination);
}
