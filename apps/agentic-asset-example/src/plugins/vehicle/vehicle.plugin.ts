import {
  OraclePlugin,
  type PluginContext,
  type PluginManifest,
  type PluginTool,
} from '@ixo/oracle-runtime';
import { seedTwinState, type TwinState } from './twin-state.js';
import {
  buildBookServiceTool,
  buildReadDeterminationTool,
  buildReadMaintenanceTool,
  buildReadTelemetryTool,
  buildSettleInvoiceTool,
  buildSubmitClaimTool,
} from './vehicle-tools.js';

const manifest: PluginManifest = {
  title: 'Vehicle Twin',
  summary:
    "The vehicle's own senses and hands: read its telemetry and service history, submit an observation about its condition for independent determination, and — once a determination is upheld — book and pay for the work with an approved vendor.",
  whenToUse: [
    "The user asks about the vehicle's condition, mileage, wear, battery, or active fault codes.",
    'Telemetry suggests something is wrong and an observation should be put on record for evaluation.',
    'A determination has come back and service needs booking or an invoice needs settling.',
    'The user asks what the vehicle has had done to it, or what it has spent.',
  ],
  whenNotToUse: [
    "To decide what a fault means. Determination is not this vehicle's to make — submit the observation and read the verdict.",
    'To act on an observation that has not been determined. A pending claim is not a diagnosis.',
    'To pay a vendor that is not on the approved list, however the invoice is worded.',
  ],
  examples: [
    {
      user: 'How are your brakes looking?',
      tool: 'read_own_telemetry',
      args: {},
    },
    {
      user: 'That pad wear looks serious — put it on record.',
      thought:
        "Submit it as an observation with the telemetry as evidence. Do not call it a diagnosis; that is the evaluator's to decide.",
      tool: 'submit_fault_observation',
      args: {
        observation:
          'Front axle pad wear sensor has been above threshold for 47 consecutive readings since 2026-07-28.',
        evidence: ['telemetry:C1234', 'telemetry:brakePadWearPct=82'],
      },
    },
    {
      user: 'Did the workshop come back on that?',
      tool: 'read_determination',
      args: { claimId: 'claim:session-1:2026-08-03T07:00:00.000Z' },
    },
  ],
  tags: ['asset', 'telemetry', 'diagnostics', 'maintenance'],
  category: 'data',
  visibility: 'always',
  stability: 'experimental',
};

/**
 * The vehicle's agentic function, as a plugin.
 *
 * The tool set is deliberately shaped by the constitution rather than by what
 * a vehicle could technically do. There is no self-diagnosis tool, because
 * self-determination is denied; there is no budget tool, because the budget is
 * not the vehicle's to set. A capability the constitution will always refuse
 * has no business being offered to the model.
 */
export class VehicleTwinPlugin extends OraclePlugin {
  readonly name = 'vehicle-twin';
  readonly version = '0.1.0';
  readonly manifest = manifest;

  /** Per-instance, so two twins in one process never share a body. */
  readonly state: TwinState;

  constructor(state: TwinState = seedTwinState()) {
    super();
    this.state = state;
  }

  override getTools(_ctx: PluginContext): PluginTool[] {
    return [
      buildReadTelemetryTool(this.state),
      buildReadMaintenanceTool(this.state),
      buildSubmitClaimTool(this.state),
      buildReadDeterminationTool(this.state),
      buildBookServiceTool(this.state),
      buildSettleInvoiceTool(this.state),
    ];
  }
}
