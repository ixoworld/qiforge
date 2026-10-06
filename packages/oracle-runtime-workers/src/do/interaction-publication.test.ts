import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { OracleInteraction } from '@ixo/oracles-events/interactions';
import { publishInteractionSnapshot } from './interaction-publication';

const update: OracleInteraction = {
  sessionId: 'session',
  requestId: 'request',
  oracleDid: 'did:oracle',
  oracleUserId: '@qi:test',
  oracleName: 'Qi',
  state: 'working',
  revision: 2,
  updatedAt: '2026-10-06T00:00:00Z',
};
const key = 'interaction-pending:request';
const stub = (name: string) =>
  env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
describe('durable interaction publication', () => {
  it('preserves a final state across failed publication and clears it after retry', async () => {
    await runInDurableObject(
      stub('interaction-publication-retry'),
      async (_instance, state) => {
        const terminal = {
          ...update,
          state: 'completed' as const,
          revision: 3,
        };
        await state.storage.put(key, terminal);
        await expect(
          publishInteractionSnapshot(
            state.storage,
            async () => {
              throw new Error('gateway reset');
            },
            terminal,
          ),
        ).rejects.toThrow('gateway reset');
        expect(await state.storage.get(key)).toEqual(terminal);
        await publishInteractionSnapshot(
          state.storage,
          async () => undefined,
          terminal,
        );
        expect(await state.storage.get(key)).toBeUndefined();
      },
    );
  });
  it('does not remove a newer final state when an older heartbeat is confirmed', async () => {
    await runInDurableObject(
      stub('interaction-publication-newer'),
      async (_instance, state) => {
        await state.storage.put(key, update);
        const terminal = {
          ...update,
          state: 'cancelled' as const,
          revision: 3,
        };
        await publishInteractionSnapshot(
          state.storage,
          async () => {
            await state.storage.put(key, terminal);
          },
          update,
        );
        expect(await state.storage.get(key)).toEqual(terminal);
      },
    );
  });
});
