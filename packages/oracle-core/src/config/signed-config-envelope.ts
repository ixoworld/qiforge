import { z } from 'zod';

/**
 * The authenticated wrapper every oracle configuration document travels in.
 *
 * Configuration is authority-bearing state: it selects prompts, models,
 * capabilities, routes, and billing limits. The runtime therefore accepts
 * config only inside an envelope that is signed (or UCAN-authorized) by the
 * oracle entity's controller, content-addressed, versioned monotonically,
 * and linked to its predecessor — so a host can serve exactly what the
 * operator published and nothing else, and a stale or forged document is
 * rejected rather than obeyed.
 *
 * Foundation scope: the SCHEMA and verification interfaces. The loader that
 * fetches, verifies, hot-reloads, and falls back to last-known-good is
 * Phase 5 (`specs/phase-5-authenticated-config-and-cf-adapter.md`) — but
 * every port already accepts a `policyDigest`, so enforcement points exist
 * from day one.
 */
export const signedConfigEnvelopeSchema = z.object({
  /** Envelope schema version (this shape), independent of the config body. */
  schemaVersion: z.literal(1),
  /**
   * Monotonically increasing, immutable version of the config body.
   * Anti-rollback: a verifier MUST reject any envelope whose version is
   * lower than the highest version it has accepted for this oracle.
   */
  configVersion: z.number().int().nonnegative(),
  /** DID of the oracle entity this configuration governs. */
  oracleDid: z.string().min(1),
  /** sha-256 hex digest of the canonicalized config body. */
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  /** DID of the controller that authorized this version. */
  issuerDid: z.string().min(1),
  /**
   * Detached authorization over `contentDigest` + the envelope metadata:
   * either a raw signature by the issuer's verification key or a UCAN
   * invocation whose audience is the runtime. Verification MUST derive the
   * issuer's authority from the oracle entity's controller policy — not
   * from mere presence in a `controller` array.
   */
  authorization: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('signature'), value: z.string().min(1) }),
    z.object({ kind: z.literal('ucan'), invocationCar: z.string().min(1) }),
  ]),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  /** Content digest of the previous accepted version (hash-chain link). */
  previousDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** Minimum harness version this config requires. */
  requiresRuntime: z.string().optional(),
  /** Upgrade channel the operator pinned. */
  runtimeChannel: z
    .union([z.literal('stable'), z.string().regex(/^pinned@.+$/)])
    .default('stable'),
  /** The configuration body itself (validated separately by its own schema). */
  config: z.record(z.string(), z.unknown()),
});

export type SignedConfigEnvelope = z.output<typeof signedConfigEnvelopeSchema>;

/** Outcome of envelope verification. */
export type EnvelopeVerification =
  | { valid: true; envelope: SignedConfigEnvelope }
  | { valid: false; reason: string };

/**
 * Host-provided verifier: checks digest integrity, issuer authority against
 * the oracle entity's controller policy, expiry, and anti-rollback against
 * the highest previously-accepted version. Implementations live in the
 * adapters (Node today, Worker in Phase 5); core owns only the contract.
 */
export interface ConfigEnvelopeVerifier {
  verify(
    envelope: unknown,
    context: { oracleDid: string; highestAcceptedVersion: number | null },
  ): Promise<EnvelopeVerification>;
}
