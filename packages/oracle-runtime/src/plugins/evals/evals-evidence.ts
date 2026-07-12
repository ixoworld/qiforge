import { z } from 'zod';
import { sha256DigestOfCanonicalJson } from './content-cid.js';

/**
 * Builders for the Evals Engine's Tier-A structured evidence contract
 * (`oracle.structured-fact-packet.v1` / `oracle.evidence-envelope.v1`).
 * They validate the exact shapes the engine's evidence pipeline enforces so
 * producers fail fast locally instead of discovering `invalid_evidence` from
 * the async evaluation job, and they compute the envelope integrity digest
 * with the engine's canonicalization so the `integrity.hash_match` gate
 * passes.
 *
 * Honesty rule: facts gathered by the claimant itself (the oracle) must be
 * marked `provenanceClass: 'client_assisted'` — the engine caps their source
 * reliability. Only independently corroborated facts may claim
 * `server_verified`. The builders default to `client_assisted`.
 */

const bpsSchema = z.number().int().min(0).max(10000);

const factOriginSchema = z.object({
  submitter: z.string().min(1).optional(),
  device: z.string().min(1).optional(),
  apiOrigin: z.string().min(1).optional(),
  issuer: z.string().min(1).optional(),
  fundingSource: z.string().min(1).optional(),
  pipelineRun: z.string().min(1).optional(),
  provenanceClass: z.enum(['client_assisted', 'server_verified']).optional(),
});

const factSourceSchema = z.object({
  evidenceId: z.string().min(1),
  locator: z.string().min(1),
  observationId: z.string().min(1).optional(),
  origin: factOriginSchema.optional(),
});

export const structuredFactSchema = z.object({
  factId: z.string().min(1),
  factType: z.string().min(1),
  statement: z.string().min(1),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string(),
  polarity: z.enum(['supports', 'refutes', 'qualifies', 'neutral']),
  modality: z.enum([
    'observed',
    'reported',
    'attested',
    'computed',
    'inferred',
    'externally_verified',
  ]),
  source: factSourceSchema,
  extractionConfidenceBps: bpsSchema.optional(),
  sourceReliabilityBps: bpsSchema.optional(),
  temporalAlignmentBps: bpsSchema.optional(),
  spatialAlignmentBps: bpsSchema.optional(),
  evidentialSupportBps: bpsSchema.optional(),
  contradictionBps: bpsSchema.optional(),
  quality: z
    .enum([
      'usable',
      'low_confidence',
      'ambiguous',
      'conflicting',
      'unsupported_media',
      'requires_human_review',
    ])
    .optional(),
});

export const sourceSnapshotSchema = z.object({
  sourceId: z.string().min(1),
  sourceType: z.string().min(1),
  authority: z.string().min(1),
  snapshotHash: z.string().min(1),
  capturedAt: z.string().min(1),
  requiredFor: z.array(z.string().min(1)).optional(),
});

export const structuredFactPacketSchema = z.object({
  schema: z.literal('oracle.structured-fact-packet.v1'),
  packetId: z.string().min(1),
  claimId: z.string().min(1),
  generatedAt: z.string().min(1).optional(),
  facts: z.array(structuredFactSchema).min(1),
  sourceSnapshots: z.array(sourceSnapshotSchema).optional(),
});

export type StructuredFact = z.infer<typeof structuredFactSchema>;
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
export type StructuredFactPacket = z.infer<typeof structuredFactPacketSchema>;

export interface BuildFactInput {
  factId: string;
  factType: string;
  statement: string;
  subject: string;
  predicate: string;
  object: string;
  /** Defaults to `supports`. */
  polarity?: StructuredFact['polarity'];
  /** Defaults to `reported` — the honest modality for claimant-observed facts. */
  modality?: StructuredFact['modality'];
  source: {
    evidenceId: string;
    locator: string;
    observationId?: string;
    origin?: z.infer<typeof factOriginSchema>;
  };
  extractionConfidenceBps?: number;
  sourceReliabilityBps?: number;
  temporalAlignmentBps?: number;
  spatialAlignmentBps?: number;
  evidentialSupportBps?: number;
  contradictionBps?: number;
  quality?: StructuredFact['quality'];
}

/**
 * Build one structured fact. Defaults: `polarity: supports`,
 * `modality: reported`, `quality: usable`, and — unless the caller states
 * otherwise — `provenanceClass: client_assisted` on the source origin.
 */
export function buildStructuredFact(input: BuildFactInput): StructuredFact {
  const origin = {
    provenanceClass: 'client_assisted' as const,
    ...(input.source.origin ?? {}),
  };
  return structuredFactSchema.parse({
    factId: input.factId,
    factType: input.factType,
    statement: input.statement,
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    polarity: input.polarity ?? 'supports',
    modality: input.modality ?? 'reported',
    source: {
      evidenceId: input.source.evidenceId,
      locator: input.source.locator,
      ...(input.source.observationId
        ? { observationId: input.source.observationId }
        : {}),
      origin,
    },
    ...(input.extractionConfidenceBps === undefined
      ? {}
      : { extractionConfidenceBps: input.extractionConfidenceBps }),
    ...(input.sourceReliabilityBps === undefined
      ? {}
      : { sourceReliabilityBps: input.sourceReliabilityBps }),
    ...(input.temporalAlignmentBps === undefined
      ? {}
      : { temporalAlignmentBps: input.temporalAlignmentBps }),
    ...(input.spatialAlignmentBps === undefined
      ? {}
      : { spatialAlignmentBps: input.spatialAlignmentBps }),
    ...(input.evidentialSupportBps === undefined
      ? {}
      : { evidentialSupportBps: input.evidentialSupportBps }),
    ...(input.contradictionBps === undefined
      ? {}
      : { contradictionBps: input.contradictionBps }),
    quality: input.quality ?? 'usable',
  });
}

export interface BuildPacketInput {
  /** MUST equal the claim.id the packet accompanies — the engine rejects mismatches as invalid_evidence. */
  claimId: string;
  packetId: string;
  generatedAt?: string;
  facts: StructuredFact[];
  sourceSnapshots?: SourceSnapshot[];
}

/** Build and validate an `oracle.structured-fact-packet.v1` evidence packet. */
export function buildEvidencePacket(
  input: BuildPacketInput,
): StructuredFactPacket {
  return structuredFactPacketSchema.parse({
    schema: 'oracle.structured-fact-packet.v1',
    packetId: input.packetId,
    claimId: input.claimId,
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
    facts: input.facts,
    ...(input.sourceSnapshots
      ? { sourceSnapshots: input.sourceSnapshots }
      : {}),
  });
}

/** Media type the engine registers for structured fact packets. */
export const FACT_PACKET_MEDIA_TYPE =
  'application/vnd.ixo.structured-fact-packet+json';

export interface BuildEnvelopeInput {
  evidenceId: string;
  /** MUST equal the claim.id — the engine rejects mismatches as invalid_evidence. */
  claimId: string;
  submitterDid: string;
  /** Defaults to the structured-fact-packet media type. */
  mediaType?: string;
  /**
   * The packet the envelope wraps. Its integrity digest is computed here with
   * the engine's canonicalization — the `integrity.hash_match` gate fails
   * closed on any other digest convention.
   */
  packet: StructuredFactPacket;
  signatureStatus?: 'valid' | 'invalid' | 'absent' | 'unverifiable';
}

/** Build an `oracle.evidence-envelope.v1` wrapper with a correct packet digest. */
export function buildEvidenceEnvelope(
  input: BuildEnvelopeInput,
): Record<string, unknown> {
  return {
    schema: 'oracle.evidence-envelope.v1',
    evidenceId: input.evidenceId,
    claimId: input.claimId,
    mediaType: input.mediaType ?? FACT_PACKET_MEDIA_TYPE,
    submitter: { did: input.submitterDid },
    integrity: {
      sha256: sha256DigestOfCanonicalJson(input.packet),
      signatureStatus: input.signatureStatus ?? 'absent',
    },
  };
}
