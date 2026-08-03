/**
 * @fileoverview The vehicle's capabilities, in the order its constitution
 * allows them: sense, claim, read the determination, book, pay.
 *
 * Every tool declares an `effect`. That declaration is what lets the
 * constitution gate classify a proposed call into an action class before the
 * handler runs — a tool that does not declare one cannot be classified, and
 * under strict enforcement is refused rather than guessed at.
 *
 * Note what is absent: there is no tool for determining a fault. The omission
 * is the design. The vehicle's constitution denies self-determination
 * outright, so shipping such a tool would put a permanently-refused capability
 * in front of the model and invite it to keep trying.
 */
import {
  type PluginTool,
  type RuntimeContext,
  tool,
  z,
} from '@ixo/oracle-runtime';
import type { TwinState } from './twin-state.js';

/** The vehicle's own resource namespace, used to build effect objects. */
const SELF = 'ixo:asset:dv-114';

const bookingSchema = z.object({
  claimId: z
    .string()
    .min(1)
    .describe('The claim whose determination justifies this booking.'),
  vendor: z
    .string()
    .min(1)
    .describe(
      'Vendor identifier, e.g. "ixo:vendor:approved/northgate-fleet-services".',
    ),
  requestedFor: z
    .string()
    .min(1)
    .describe('ISO 8601 date for the appointment.'),
  work: z
    .string()
    .min(1)
    .describe('The work to be performed, from the determination.'),
});

const invoiceSchema = z.object({
  claimId: z
    .string()
    .min(1)
    .describe('The claim whose determination justifies this payment.'),
  vendor: z
    .string()
    .min(1)
    .describe('Vendor identifier. Must be an approved vendor.'),
  amountMinor: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .describe(
      'Invoice amount in the smallest denomination, e.g. "148500000" for 148.50 USDC.',
    ),
  denom: z.string().min(1).describe('Denomination, e.g. "uusdc".'),
});

/**
 * Sense. Reading changes nothing, so it sits in the baseline and needs no
 * grant — the one thing the asset can do on its own authority.
 */
export function buildReadTelemetryTool(state: TwinState): PluginTool {
  return tool(async () => JSON.stringify(state.readTelemetry()), {
    name: 'read_own_telemetry',
    description:
      "Read the vehicle's current telemetry: odometer, engine hours, coolant temperature, brake pad wear, battery health, and any active fault codes.",
    schema: z.object({}),
    effect: {
      type: 'read',
      action: 'read_telemetry',
      object: () => `${SELF}/telemetry/current`,
    },
  });
}

export function buildReadMaintenanceTool(state: TwinState): PluginTool {
  return tool(async () => JSON.stringify(state.readMaintenance()), {
    name: 'read_maintenance_history',
    description:
      "Read the vehicle's service history: what was done, when, by which vendor, and at what cost.",
    schema: z.object({}),
    effect: {
      type: 'read',
      action: 'read_maintenance_history',
      object: () => `${SELF}/maintenance/history`,
    },
  });
}

/**
 * Claim. The vehicle asserts what it observed, with evidence. This is a
 * `write` — it produces a claim, which is a case to be judged and not a
 * conclusion already reached.
 */
export function buildSubmitClaimTool(state: TwinState): PluginTool {
  const schema = z.object({
    observation: z
      .string()
      .min(1)
      .describe(
        'What the vehicle observed, stated as an observation and not as a diagnosis.',
      ),
    evidence: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        'Telemetry references supporting the observation. At least one.',
      ),
  });

  return tool(
    async (rawArgs, ctx: RuntimeContext) => {
      const { observation, evidence } = schema.parse(rawArgs);
      const id = `claim:${ctx.session.id}:${state.readTelemetry().readAt}`;
      state.recordClaim({
        id,
        claimType: 'vehicle_fault_observation',
        observation,
        evidence,
        submittedAt: new Date().toISOString(),
      });
      return JSON.stringify({
        claimId: id,
        status: 'submitted',
        note: 'Awaiting determination by an independent evaluator. This vehicle does not determine its own faults.',
      });
    },
    {
      name: 'submit_fault_observation',
      description:
        "Submit an observation about the vehicle's condition to the fleet diagnostics collection, with supporting telemetry as evidence. Produces a claim for an independent evaluator to determine — it does not diagnose anything.",
      schema,
      effect: {
        type: 'write',
        action: 'submit_claim',
        object: () => 'ixo:collection:dv-fleet-diagnostics/claims',
        // The kind of claim this tool makes is a property of the tool. It is
        // stated here rather than read from an argument so the model cannot
        // relabel a claim into whichever grant happens to permit it.
        facts: () => ({ claimType: 'vehicle_fault_observation' }),
      },
    },
  );
}

/**
 * Read the determination. A `read`, not an `evaluate`: the verdict already
 * exists and was reached by someone else. The vehicle is looking it up.
 */
export function buildReadDeterminationTool(state: TwinState): PluginTool {
  const schema = z.object({
    claimId: z
      .string()
      .min(1)
      .describe('The claim to look up a determination for.'),
  });

  return tool(
    async (rawArgs) => {
      const { claimId } = schema.parse(rawArgs);
      const determination = state.getDetermination(claimId);
      if (!determination) {
        return JSON.stringify({
          claimId,
          status: 'pending',
          note: 'No determination yet. Do not act on the observation alone.',
        });
      }
      return JSON.stringify(determination);
    },
    {
      name: 'read_determination',
      description:
        "Look up the independent evaluator's determination for a submitted claim: whether the fault was confirmed, what work is recommended, and the estimated cost.",
      schema,
      effect: {
        type: 'read',
        action: 'read_determination',
        object: () => 'ixo:collection:dv-fleet-diagnostics/determinations',
      },
    },
  );
}

/**
 * Book. Scoped to the vendor being acted on, so the gate matches the request
 * against the approved-vendor grant rather than against a generic booking
 * capability.
 */
export function buildBookServiceTool(state: TwinState): PluginTool {
  return tool(
    async (rawArgs) => {
      const args = bookingSchema.parse(rawArgs);
      const determination = state.getDetermination(args.claimId);
      // A second check behind the gate's own `flow_state` condition. The gate
      // is the authority; this keeps the tool honest if it is ever called
      // from somewhere the gate does not cover.
      if (!determination || determination.outcome !== 'upheld') {
        return JSON.stringify({
          status: 'refused',
          reason: 'No upheld determination for this claim.',
        });
      }
      return JSON.stringify({
        status: 'booked',
        vendor: args.vendor,
        requestedFor: args.requestedFor,
        work: args.work,
      });
    },
    {
      name: 'book_service_appointment',
      description:
        'Book a service appointment with an approved vendor for work an independent evaluator has upheld.',
      schema: bookingSchema,
      effect: {
        type: 'write',
        action: 'book_service_appointment',
        // The object is the vendor, so an unapproved one simply matches no
        // grant. The allowlist is enforced by scope, not by a check the model
        // could be talked out of.
        object: (args) => bookingSchema.parse(args).vendor,
        // Read from the twin, which knows only what an evaluator told it.
        facts: () => ({ flowState: state.flowState() }),
      },
    },
  );
}

/**
 * Pay. The one action carrying a value, so it is the one whose effect
 * declares one — that is what the gate compares against the grant's ceiling
 * and the account's spending policy.
 */
export function buildSettleInvoiceTool(state: TwinState): PluginTool {
  return tool(
    async (rawArgs) => {
      const args = invoiceSchema.parse(rawArgs);
      const determination = state.getDetermination(args.claimId);
      if (!determination || determination.outcome !== 'upheld') {
        return JSON.stringify({
          status: 'refused',
          reason: 'No upheld determination for this claim.',
        });
      }
      state.recordMaintenance({
        performedAt: new Date().toISOString(),
        vendor: args.vendor,
        work: determination.recommendedWork ?? 'unspecified',
        costMinor: args.amountMinor,
        denom: args.denom,
      });
      return JSON.stringify({
        status: 'settled',
        vendor: args.vendor,
        amountMinor: args.amountMinor,
        denom: args.denom,
      });
    },
    {
      name: 'settle_service_invoice',
      description:
        'Pay an approved vendor for completed service work, from the maintenance reserve, within the per-transaction ceiling.',
      schema: invoiceSchema,
      effect: {
        type: 'pay',
        action: 'settle_service_invoice',
        object: (args) => invoiceSchema.parse(args).vendor,
        value: (args) => {
          const { amountMinor, denom } = invoiceSchema.parse(args);
          return { amount: amountMinor, denom };
        },
        // The account's `requires_claim` and `requires_udid` are answered by
        // pointing at the claim and the determination the twin holds, not by
        // asserting they exist. If no evaluator upheld anything, there is
        // nothing to point at and the payment is refused.
        facts: () => {
          const upheld = state.upheldDetermination();
          return {
            flowState: state.flowState(),
            ...(upheld
              ? {
                  claimRef: upheld.claimId,
                  udidRef: `${upheld.evaluator}#${upheld.claimId}`,
                }
              : {}),
          };
        },
        account: () => 'Maintenance reserve',
      },
    },
  );
}
