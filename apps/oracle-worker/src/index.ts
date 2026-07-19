import {
  dataPolicySchema,
  registeredModelAdapters,
  signedConfigEnvelopeSchema,
} from '@ixo/oracle-core';
import type { SpikeEnv, SpikeExecutionContext } from './cf-types.js';

export { OracleSessionDO } from './oracle-session-do.js';

/**
 * FAIL-CLOSED COMPILE SPIKE of the Cloudflare oracle adapter.
 *
 * Boot can never validate here — the spike ships no signed config envelope,
 * no ports, and registers NO model adapter, so no billable model call is
 * possible by construction. Every route answers 503 with the reason. What
 * the spike proves is narrower and real: `@ixo/oracle-core` (kernel, turn
 * seam, routing, model policy, config schemas) compiles into a
 * workerd-shaped entry with no Node dependencies and no `nodejs_compat`.
 *
 * The deployable adapter is Phase 5
 * (`specs/phase-5-authenticated-config-and-cf-adapter.md`): one
 * Workers-for-Platforms user Worker per oracle DID, booted from a verified
 * SignedConfigEnvelope, with ports enforcing the DataPolicy.
 */
interface BootRefusal {
  reason: string;
  detail: string;
}

function failClosedBoot(): BootRefusal {
  // Order matters for the message: config authentication is the first gate.
  const envelope = signedConfigEnvelopeSchema.safeParse(undefined);
  if (!envelope.success) {
    return {
      reason: 'no-signed-config',
      detail:
        'Boot requires a verified SignedConfigEnvelope; the spike ships none.',
    };
  }
  const policy = dataPolicySchema.safeParse(undefined);
  if (!policy.success) {
    return {
      reason: 'no-data-policy',
      detail: 'Boot requires a DataPolicy; the spike ships none.',
    };
  }
  return {
    reason: 'no-ports',
    detail: 'No checkpointer/matrix/credential ports are wired in the spike.',
  };
}

const refusal = failClosedBoot();

export default {
  fetch(
    _request: Request,
    _env: SpikeEnv,
    _ctx: SpikeExecutionContext,
  ): Response {
    return Response.json(
      {
        error: 'oracle-worker is a fail-closed compile spike — not deployable',
        boot: refusal,
        // Asserted in tooling as well: an empty adapter registry means no
        // model call can be constructed, billable or otherwise.
        registeredModelAdapters: registeredModelAdapters(),
      },
      { status: 503, headers: { 'Retry-After': 'never' } },
    );
  },
};
