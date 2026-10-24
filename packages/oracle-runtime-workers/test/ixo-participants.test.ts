import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixGatewayDO } from '../src/matrix/gateway-do';
import type { SqliteTestDO } from '../src/sqlite/test-do';
import type { OracleWorkerEnv } from '../src/do/contracts';
import { createCurrentIxoAudienceReader } from '../src/do/ixo-tools';

const unused = (): never => {
  throw new Error('unused namespace');
};
const namespace = {
  newUniqueId: unused,
  idFromName: unused,
  idFromString: unused,
  get: unused,
  getByName: unused,
  getExisting: unused,
  jurisdiction: unused,
};
class ParticipantGateway extends MatrixGatewayDO {
  protected override async startedClient(): Promise<never> {
    throw new Error('must not start the bot');
  }
  override async ensureStarted(): Promise<never> {
    throw new Error('must not start the bot');
  }
  override async getJoinedRoomMembers(): Promise<string[]> {
    throw new Error('cached participant helper must not run');
  }
  override async joinRoom(): Promise<string> {
    throw new Error('must not join to read participants');
  }
}
async function gatewayTest(
  name: string,
  run: (gateway: ParticipantGateway, requests: Request[]) => Promise<void>,
  withCredentials = true,
) {
  const requests: Request[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return env.LOOPBACK.fetch(request);
  });
  const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
  await runInDurableObject(stub, async (_instance: SqliteTestDO, state) => {
    const config = {
      USER_ORACLE: namespace,
      MATRIX_GATEWAY: namespace,
      ORACLE_NAME: 'test',
      ORACLE_DID: 'did:ixo:oracle',
      BLOCKSYNC_GRAPHQL_URL: 'https://mx.test/ixo-participants/graphql',
      MATRIX_BASE_URL: 'https://mx.test/ixo-participants',
      MATRIX_ORACLE_ADMIN_USER_ID: '@oracle:mx.test',
      MATRIX_ORACLE_ADMIN_PASSWORD: 'unused',
      OPEN_ROUTER_API_KEY: 'unused',
      LOG_LEVEL: 'silent',
    } satisfies OracleWorkerEnv;
    if (withCredentials)
      await state.storage.put('identity:bot-client', {
        userId: '@oracle:mx.test',
        deviceId: 'native-test',
        accessToken: 'native-participant-token',
      });
    const gateway = new ParticipantGateway(state, config);
    await run(gateway, requests);
  });
}
afterEach(() => vi.unstubAllGlobals());

describe('native participant RPC through workerd fetch', () => {
  it('fails closed on a cold gateway without starting or logging in', async () => {
    await gatewayTest(
      'native-participants-cold',
      async (gateway, requests) => {
        expect(
          await gateway.ixoToolsParticipants('!private:mx.test'),
        ).toBeNull();
        expect(requests).toEqual([]);
      },
      false,
    );
  });

  it('reads fresh complete membership without a cached conversational heuristic', async () => {
    await gatewayTest(
      'native-participants-fresh',
      async (gateway, requests) => {
        expect(await gateway.ixoToolsParticipants('!private:mx.test')).toEqual({
          oracleMatrixId: '@oracle:mx.test',
          joined: ['@did-ixo-alice:mx.test', '@oracle:mx.test'],
        });
        expect(
          (await gateway.ixoToolsParticipants('!shared:mx.test'))?.joined,
        ).toHaveLength(3);
        expect(requests).toHaveLength(2);
        expect(requests.every((request) => request.redirect === 'manual')).toBe(
          true,
        );
      },
    );
  });
  it('does not join on 403, follow redirects, or accept partial payloads', async () => {
    await gatewayTest(
      'native-participants-denied',
      async (gateway, requests) => {
        for (const room of [
          '!forbidden:mx.test',
          '!redirect:mx.test',
          '!malformed:mx.test',
        ])
          expect(await gateway.ixoToolsParticipants(room)).toBeNull();
        expect(requests).toHaveLength(3);
        expect(
          requests.every((request) => new URL(request.url).host === 'mx.test'),
        ).toBe(true);
      },
    );
  });
  it('protects mirrored Portal sessions with current owner and room evidence', async () => {
    await gatewayTest('native-participants-portal', async (gateway) => {
      const input = {
        client: 'portal',
        sessionId: '$session',
        roomId: '!private:mx.test',
        userDid: 'did:ixo:alice',
        blocksyncUri: 'https://mx.test/ixo-participants/graphql',
        participants: (roomId: string) => gateway.ixoToolsParticipants(roomId),
      } satisfies Parameters<typeof createCurrentIxoAudienceReader>[0];
      expect(await createCurrentIxoAudienceReader(input)()).toBe('private');
      expect(
        await createCurrentIxoAudienceReader({
          ...input,
          roomId: '!shared:mx.test',
        })(),
      ).toBe('shared');
      expect(
        await createCurrentIxoAudienceReader({
          ...input,
          blocksyncUri: 'https://mx.test/ixo-participants/graphql-failed',
        })(),
      ).toBe('shared');
    });
  });
});
