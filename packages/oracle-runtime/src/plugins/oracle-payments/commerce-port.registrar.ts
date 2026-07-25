import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  clearCommerceRouterPort,
  setCommerceRouterPort,
} from '../../modules/messages/commerce-router-port.js';
import { AgentCardService } from './agent-card.service.js';
import { ContractGateService } from './contract-gate.service.js';
import { EngagementService } from './engagement.service.js';
import { toRoutedService } from './util.js';
import { WorkIntentService } from './work-intent.service.js';

/**
 * Registers the plugin's commerce knowledge on the core `CommerceRouterPort`
 * slot at module init (the `setDeliverHandler`/`setRoomSessionResolver`
 * precedent): agent-card services for the classifier, thread engagements,
 * the contract gate, and the escrow-first engagement start (the chain write
 * stays here — the core router only learns pass or fail). Without this module
 * the port stays unregistered and
 * the core router is inert — Matrix turns behave exactly as before.
 */
@Injectable()
export class CommerceRouterPortRegistrar
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CommerceRouterPortRegistrar.name);

  constructor(
    private readonly config: ConfigService,
    private readonly agentCard: AgentCardService,
    private readonly engagement: EngagementService,
    private readonly gate: ContractGateService,
    private readonly intent: WorkIntentService,
  ) {}

  onModuleInit(): void {
    const entityDid = this.config.getOrThrow<string>('ORACLE_ENTITY_DID');
    const routerModel = this.config.get<string>('ORACLE_PAYMENTS_ROUTER_MODEL');

    setCommerceRouterPort({
      ...(routerModel ? { routerModel } : {}),
      getServices: async () => {
        if (!entityDid) return null;
        const services = await this.agentCard.getServices(entityDid);
        return services ? services.map(toRoutedService) : null;
      },
      findActiveEngagement: ({ senderDid, roomId, threadId }) =>
        this.engagement.findActiveForUser({
          userDid: senderDid,
          roomId,
          threadId,
        }),
      checkContractGate: (params) => this.gate.check(params),
      startEngagement: (roomId, threadId, start) =>
        this.intent.startEngagement(roomId, threadId, start),
    });
    this.logger.log('[oracle-payments] commerce router port registered.');
  }

  onModuleDestroy(): void {
    clearCommerceRouterPort();
  }
}
