import type { OracleInteraction } from '@ixo/oracles-events/interactions';

/** A lost gateway RPC leaves durable intent; an older acknowledgement cannot erase a newer one. */
export async function publishInteractionSnapshot(
  storage: Pick<DurableObjectStorage, 'transaction'>,
  publish: (update: OracleInteraction) => Promise<void>,
  update: OracleInteraction,
): Promise<void> {
  await publish(update);
  await storage.transaction(async (transaction) => {
    const key = `interaction-pending:${update.requestId}`;
    const pending = await transaction.get<OracleInteraction>(key);
    if (pending && pending.revision <= update.revision)
      await transaction.delete(key);
  });
}
