/**
 * @fileoverview Makes the entity's constitution available everywhere inside
 * Nest.
 *
 * `@Global` for the same reason as the UCAN module: the gate, the prompt
 * composer and the decision recorder all need it, they sit in unrelated parts
 * of the tree, and threading an import through every one of them would make
 * the constitution look optional to whichever module forgot.
 */
import { MatrixManager } from '@ixo/matrix';
import { Global, Logger, Module, type DynamicModule } from '@nestjs/common';
import type { DomainContext } from '../../constitution/domain-context.js';
import { setCurrentDecisionLedger } from './current-ledger.js';
import {
  DecisionLedgerService,
  type DecisionTransport,
} from './decision-ledger.service.js';
import {
  DOMAIN_CONTEXT,
  DomainContextService,
} from './domain-context.service.js';

/**
 * The ledger's transport, over the entity's own Matrix client.
 *
 * Resolved per call rather than captured, because the client does not exist
 * when this module is constructed — Matrix initialises in the background well
 * after Nest is up, which is the same reason the ledger buffers.
 */
function matrixTransport(): DecisionTransport {
  const client = () => {
    const mx = MatrixManager.getInstance().getClient();
    if (!mx) throw new Error('Matrix client is not available.');
    return mx.mxClient;
  };
  return {
    sendEvent: (roomId, type, content) =>
      client().sendEvent(roomId, type, content),
    setState: async (roomId, type, stateKey, content) => {
      await client().sendStateEvent(roomId, type, stateKey, content);
    },
  };
}

@Global()
@Module({})
export class DomainContextModule {
  /**
   * Binds the already-loaded constitution into the container.
   *
   * Takes the context rather than a path: loading it here would mean a
   * document failing its checks throws during module construction, where the
   * message competes with a Nest dependency-resolution stack trace instead of
   * reading as the boot refusal it is.
   */
  static register(
    context: DomainContext,
    options: { decisionsRoomId?: string | null } = {},
  ): DynamicModule {
    return {
      module: DomainContextModule,
      providers: [
        { provide: DOMAIN_CONTEXT, useValue: context },
        {
          provide: DomainContextService,
          useFactory: (ctx: DomainContext) => new DomainContextService(ctx),
          inject: [DOMAIN_CONTEXT],
        },
        {
          provide: DecisionLedgerService,
          useFactory: (ctx: DomainContext) => {
            const ledger = new DecisionLedgerService({
              domain: ctx,
              roomId: options.decisionsRoomId ?? null,
              transport: matrixTransport(),
              logger: new Logger(DecisionLedgerService.name),
            });
            // For runtime code that only ever sees `RuntimeContext` — see
            // `current-ledger.ts` for why that cannot carry the ledger.
            setCurrentDecisionLedger(ledger);
            return ledger;
          },
          inject: [DOMAIN_CONTEXT],
        },
      ],
      exports: [DomainContextService, DecisionLedgerService, DOMAIN_CONTEXT],
    };
  }
}
