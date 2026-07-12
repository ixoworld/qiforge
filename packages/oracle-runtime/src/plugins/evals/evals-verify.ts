import {
  PublishedIssuerKeysError,
  verifyUdidReceipt,
} from '@ixo/udid-verify';
import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool } from '../../plugin-api/types.js';
import {
  isEvalsApiError,
  labelOutcome,
  type EvalsEngineClient,
} from './evals-client.js';

const verifySchema = z
  .object({
    compactJws: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The compact JWS UDID receipt to verify (the three-part dot-separated token from get_evaluation_udid or presented by a counterparty). Provide this OR claimId.',
      ),
    claimId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Fetch the receipt for this claim from the configured engine first, then verify it. Provide this OR compactJws.',
      ),
    expectedAud: z
      .string()
      .min(1)
      .describe(
        'The audience the determination must be issued for (the deed.aud used at submission — typically your DID or the DID you act for). Verification fails closed on a mismatch; never copy this from the receipt itself.',
      ),
    issuerUrl: z
      .string()
      .url()
      .optional()
      .describe(
        "Base URL of the engine deployment that ISSUED the receipt, when it differs from this oracle's configured engine (counterparty receipts). Public keys are fetched from its public /v1/issuer-keys route; no auth token is sent.",
      ),
    clockSkewSec: z
      .number()
      .int()
      .min(0)
      .max(300)
      .optional()
      .describe('Tolerated clock skew in seconds when checking expiry (default 0).'),
  })
  .refine((v) => v.compactJws !== undefined || v.claimId !== undefined, {
    message: 'Provide compactJws or claimId.',
  });

const VERIFY_DESCRIPTION = `Cryptographically verify a UDID receipt locally — trust the determination without trusting whoever handed it to you.

WHAT IT DOES:
- Takes a signed compact-JWS receipt (from get_evaluation_udid, a sub-agent, or a counterparty oracle) or a claimId to fetch one.
- Fetches the ISSUING engine's published public keys from its public /v1/issuer-keys route (no auth needed; pass issuerUrl when the receipt came from a different deployment than this oracle's configured engine).
- Verifies everything locally with @ixo/udid-verify — the same code the engine runs: Ed25519/EdDSA signature (algorithm pinned, key selected by the receipt's kid, so rotated historical keys still verify), audience binding, expiry, canonical payload bytes, and the normative UDID payload schema.
- Returns { valid, failures, receipt } — valid: true means the receipt is authentic, addressed to expectedAud, unexpired, and well-formed; receipt.res (outcome, patch, reason) is then the trusted decision surface.

USE THIS FOR ORACLE-TO-ORACLE TRUST:
- Before accepting a sub-agent's or counterparty's claimed work, require their UDID receipt and verify it with the aud YOU expect. A receipt addressed to someone else, tampered with, expired, or signed by an unknown key returns valid: false with named failures (signature_invalid, audience_mismatch, expired, canonical_bytes_mismatch, payload_schema_invalid, unknown_kid).
- A failed verification is a final cryptographic verdict on that exact token — do not retry; report the failures.

Returns { "error": "udid_not_issued" } when fetching by claimId and no receipt exists yet, and { "error": "issuer_keys_unavailable" } when the issuer's key endpoint cannot be reached or serves malformed keys.`;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Decode the JWS protected header just to surface the signing kid (display only). */
function headerKid(compactJws: string): string | undefined {
  try {
    const header: unknown = JSON.parse(
      Buffer.from(compactJws.split('.')[0] ?? '', 'base64url').toString('utf8'),
    );
    const kid = asRecord(header)?.kid;
    return typeof kid === 'string' ? kid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Project the verified payload down to the fields an agent reasons over.
 * Only meaningful when the verification passed — the caller gates on `valid`.
 */
function summarizeReceipt(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  const res = asRecord(payload.res);
  const out = asRecord(payload.out);
  const outcome = typeof res?.outcome === 'number' ? res.outcome : undefined;
  return {
    iss: payload.iss,
    aud: payload.aud,
    sub: payload.sub,
    jti: payload.jti,
    iat: payload.iat,
    ...(payload.exp === undefined ? {} : { exp: payload.exp }),
    ...(outcome === undefined
      ? {}
      : { outcome, outcomeLabel: labelOutcome(outcome) }),
    ...(res?.reason === undefined ? {} : { reason: res.reason }),
    ...(res?.patch === undefined ? {} : { patch: res.patch }),
    ...(out?.summary === undefined ? {} : { summary: out.summary }),
  };
}

/**
 * Build the local receipt-verification tool. Verification never trusts the
 * engine's word at check time: only public keys are fetched (from the public
 * issuer-keys route of whichever deployment issued the receipt) and every
 * check runs locally via the published @ixo/udid-verify package.
 */
export function createVerifyUdidTool(client: EvalsEngineClient): PluginTool {
  return tool(
    async (rawArgs, ctx) => {
      const { compactJws, claimId, expectedAud, issuerUrl, clockSkewSec } =
        verifySchema.parse(rawArgs);

      let receiptJws = compactJws;
      if (receiptJws === undefined) {
        // claimId path: fetch the receipt from the configured engine, then
        // verify it exactly like a presented one.
        const fetched = await client.getUdid(claimId as string, ctx.abortSignal);
        if (isEvalsApiError(fetched)) return fetched;
        receiptJws = fetched.compactJws;
      }

      let verification;
      try {
        verification = await verifyUdidReceipt(receiptJws, {
          expectedAud,
          issuerKeys: issuerUrl ?? client.baseUrl,
          ...(clockSkewSec === undefined ? {} : { clockSkewSec }),
          signal: ctx.abortSignal,
        });
      } catch (e) {
        if (e instanceof PublishedIssuerKeysError) {
          return {
            error: 'issuer_keys_unavailable',
            guidance: `Could not resolve the issuer's public keys from ${issuerUrl ?? client.baseUrl}/v1/issuer-keys: ${e.message}. Check issuerUrl points at the deployment that issued this receipt.`,
          };
        }
        throw e;
      }

      const kid = headerKid(receiptJws);
      return {
        valid: verification.valid,
        failures: verification.failures,
        issuerKeysSource: issuerUrl ?? client.baseUrl,
        ...(kid === undefined ? {} : { kid }),
        ...(verification.valid
          ? { receipt: summarizeReceipt(verification.report.payload) }
          : { errors: verification.report.errors }),
      };
    },
    {
      name: 'verify_evaluation_udid',
      description: VERIFY_DESCRIPTION,
      schema: verifySchema,
    },
  );
}
