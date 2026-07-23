import { type DynamicModule, Module } from '@nestjs/common';
import { AgentCardService } from './agent-card.service.js';
import { ClaimStatusWatcher } from './claim-status.watcher.js';
import { CommerceRouterPortRegistrar } from './commerce-port.registrar.js';
import { ContractGateService } from './contract-gate.service.js';
import { ContractRecordService } from './contract-record.service.js';
import { ContractedEventListener } from './contracted-event.listener.js';
import { EngagementService } from './engagement.service.js';
import { WorkClaimService } from './work-claim.service.js';
import { WorkClaimWiring } from './work-claim.wiring.js';
import { WorkIntentService } from './work-intent.service.js';

export interface OraclePaymentsModuleServices {
  agentCard: AgentCardService;
  contractRecord: ContractRecordService;
  engagement: EngagementService;
  contractGate: ContractGateService;
  workIntent: WorkIntentService;
  workClaim: WorkClaimService;
}

/**
 * Nest module for the oracle-payments plugin. Provides the plugin's resolver +
 * lookup services (as the same instances the request tools and shared-state
 * accessor use), the `ixo.oracle.contracted` cache-bust listener (which also
 * wires the engine token provider onto {@link ContractRecordService} at boot),
 * the registrar that plugs the plugin's commerce knowledge into the core
 * message router's port slot, the wiring that hands the delivery lane the
 * oracle's claim-signing key, and the cron that reports each submitted claim's
 * evaluation outcome back into its thread.
 */
@Module({})
export class OraclePaymentsModule {
  static register(services: OraclePaymentsModuleServices): DynamicModule {
    return {
      module: OraclePaymentsModule,
      providers: [
        { provide: AgentCardService, useValue: services.agentCard },
        { provide: ContractRecordService, useValue: services.contractRecord },
        { provide: EngagementService, useValue: services.engagement },
        { provide: ContractGateService, useValue: services.contractGate },
        { provide: WorkIntentService, useValue: services.workIntent },
        { provide: WorkClaimService, useValue: services.workClaim },
        ClaimStatusWatcher,
        ContractedEventListener,
        CommerceRouterPortRegistrar,
        WorkClaimWiring,
      ],
      exports: [
        AgentCardService,
        ContractRecordService,
        EngagementService,
        ContractGateService,
        WorkIntentService,
        WorkClaimService,
        ClaimStatusWatcher,
      ],
    };
  }
}
