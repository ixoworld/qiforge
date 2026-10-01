import { MatrixManager } from '@ixo/matrix';
import {
  createUcanTokenProvider,
  type GetUcanToken,
} from '@ixo/oracles-chain-client';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { normalizeDid } from '../../config/normalize-did.js';
import { ORACLE_CONTRACTED_EVENT_TYPE } from '../../matrix/oracle-component-event.js';
import type { Logger as PluginLogger } from '../../plugin-api/types.js';
import { UcanService } from '../../modules/ucan/ucan.service.js';
import { ContractGateService } from './contract-gate.service.js';
import { ContractRecordService } from './contract-record.service.js';

/** matrix-bot-sdk emits `room.event` for every timeline event, post-decryption. */
const ROOM_EVENT = 'room.event';

/** The fields of a timeline event this listener reads. */
const TimelineEventSchema = z.object({
  type: z.string().optional(),
  sender: z.string().optional(),
});

/**
 * Cache-bust core: if `event` is an `ixo.oracle.contracted` from a user DID,
 * invalidate that subscriber's cached contract record and return the DID.
 * Returns `null` for any other event type or an unparseable/non-DID sender.
 * The event is never trusted as a contract record — only as a bust signal.
 */
export function applyContractedCacheBust(
  event: unknown,
  contractRecord: Pick<ContractRecordService, 'invalidate'>,
  logger?: Pick<PluginLogger, 'debug'>,
): string | null {
  const parsed = TimelineEventSchema.safeParse(event);
  if (!parsed.success) return null;
  if (parsed.data.type !== ORACLE_CONTRACTED_EVENT_TYPE) return null;

  const sender = parsed.data.sender;
  if (!sender) return null;

  let senderDid: string;
  try {
    senderDid = normalizeDid(sender);
  } catch {
    // Not a user DID sender — nothing to invalidate.
    return null;
  }

  contractRecord.invalidate(senderDid);
  logger?.debug?.(
    `[oracle-payments] invalidated contract cache for ${senderDid}.`,
  );
  return senderDid;
}

/**
 * Wires the engine token provider onto {@link ContractRecordService} and
 * listens for `ixo.oracle.contracted` events across every joined room. The
 * event is an untrusted cache-buster: on receipt the sender's cached contract
 * record is dropped so the next lookup re-queries the engine.
 *
 * Custom-typed timeline events are observed on the underlying matrix-bot-sdk
 * client's `room.event` emission — `MatrixManager.onMessage` fires only for
 * `m.room.message`, so it cannot see these.
 */
@Injectable()
export class ContractedEventListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractedEventListener.name);
  private unsubscribe?: () => void;

  constructor(
    private readonly config: ConfigService,
    private readonly ucan: UcanService,
    private readonly contractRecord: ContractRecordService,
    private readonly contractGate: ContractGateService,
  ) {}

  onModuleInit(): void {
    this.wireTokenProvider();

    MatrixManager.getInstance()
      .init()
      .then(() => this.subscribe())
      .catch((error) =>
        this.logger.error(
          `[oracle-payments] matrix init failed; contracted listener inactive: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  private wireTokenProvider(): void {
    const oracleDid = this.config.getOrThrow<string>('ORACLE_DID');
    let provider: GetUcanToken | null = null;
    this.contractRecord.setTokenProvider(async (engineUrl) => {
      const mnemonic = this.ucan.getSigningMnemonic();
      if (!mnemonic) return null;
      provider ??= createUcanTokenProvider({ mnemonic, did: oracleDid });
      return provider(engineUrl, 'ixo:eval-engine');
    });
  }

  private subscribe(): void {
    const client = MatrixManager.getInstance().getClient()?.mxClient;
    if (!client) {
      this.logger.warn(
        '[oracle-payments] no matrix client — ixo.oracle.contracted listener inactive.',
      );
      return;
    }
    client.on(ROOM_EVENT, this.handleRoomEvent);
    this.unsubscribe = () => client.off(ROOM_EVENT, this.handleRoomEvent);
    this.logger.log(
      '[oracle-payments] ixo.oracle.contracted listener registered.',
    );
  }

  private readonly handleRoomEvent = (
    _roomId: unknown,
    event: unknown,
  ): void => {
    const senderDid = applyContractedCacheBust(
      event,
      this.contractRecord,
      this.logger,
    );
    // The contract gate keeps its own short record cache in front of the
    // record service — bust both so a fresh contract is usable immediately.
    if (senderDid) this.contractGate.invalidate(senderDid);
  };
}
