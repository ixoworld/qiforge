import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionReferenceV1 } from '@ixo/action-protocol';
import { makeRuntimeContext } from '../src/core/test-fixtures';
import { HubActionClient } from '../src/hub-actions/client';
import { prepareHubAction } from '../src/hub-actions/request';
import type { HubActionTestDO } from '../src/hub-actions/test-do';
import { JOB_LIST_URLS, resetCatalogCache } from '../src/plugins/yoma/catalog';
import milestoneApplication from '../src/plugins/yoma/fixtures/form-9787-bco.json';
import { YomaPlugin } from '../src/plugins/yoma';
import type { RuntimeContext } from '../src/plugin-api/types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Cloudflare test binding augmentation
  namespace Cloudflare {
    interface Env {
      HUB_ACTION_TEST: DurableObjectNamespace<HubActionTestDO>;
    }
  }
}

/**
 * The Yoma plugin inside workerd (survey-core included), sending an
 * application card through the runtime's real `prepareHubAction` and its
 * real `HubActionStore` in Durable Object SQLite: a send the Hub answers 503
 * leaves its request key bound to that run, and the retry on the person's
 * next message gets a key of its own and goes through.
 */
const ADDRESS = 'ixo1cra6p0jefu8f907gqngkfzxur26k7f73an4v95';
const DID = `did:ixo:${ADDRESS}`;
const ENTITY = 'did:ixo:entity:0123456789abcdef0123456789abcdef';
const PROTOCOL = 'did:ixo:entity:11111111111111111111111111111111';
const BLOCKSYNC = 'https://blocksync.test/graphql';
const HUB = 'https://hub.test';
const WORKER = JOB_LIST_URLS.mainnet!;

function upstream(url: string, init?: RequestInit): Response {
  if (url === `${WORKER}/v1/entities`)
    return Response.json({ data: { entities: [ENTITY] } });
  if (url.startsWith(`${WORKER}/v1/collections/`))
    return Response.json({ data: { blacklist: [] } });
  if (url === 'https://forms.test/bco')
    return Response.json(milestoneApplication);
  if (url === BLOCKSYNC) {
    const query = JSON.parse(String(init?.body)).query as string;
    const data: Record<string, unknown> = {};
    if (query.includes('c: claimCollections'))
      data.c = {
        nodes: [
          {
            id: '9787',
            entity: ENTITY,
            admin: 'ixo1x4p6j0h3mzv8e7mhd6q9wquh2vqd9yh5ttnzyg',
            protocol: PROTOCOL,
            state: 0,
            startDate: null,
            endDate: null,
            quota: '0',
            count: '0',
            payments: null,
          },
        ],
      };
    if (query.includes('e: entities'))
      data.e = {
        nodes: [
          { id: ENTITY, settings: null, service: [], linkedResource: [] },
          {
            id: PROTOCOL,
            settings: null,
            service: [],
            linkedResource: [
              { id: '{id}#bco', serviceEndpoint: 'https://forms.test/bco' },
            ],
          },
        ].filter((e) => query.includes(JSON.stringify(e.id))),
      };
    return Response.json({ data });
  }
  return new Response('not found', { status: 404 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCatalogCache();
});

describe('yoma under workerd', () => {
  it('retries a card the Hub answered 503 with a key of its own, through the real store', async () => {
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) =>
        upstream(String(input), init),
    );
    const store = env.HUB_ACTION_TEST.get(
      env.HUB_ACTION_TEST.idFromName('yoma-retry'),
    );
    const id = 'Y'.repeat(32);
    let posts = 0;
    const client = new HubActionClient({
      origin: HUB,
      key: 'service-key',
      fetcher: {
        fetch: async (request: Request) => {
          if (request.method === 'GET')
            return Response.json({
              version: 'ixo.auth-capabilities/2',
              accountId: 'account-1',
              oracleDid: 'did:ixo:oracle',
              network: 'ixo mainnet',
              resourceOrigin: null,
              operations: ['ixo.bid.submit.v1'],
              forms: [],
              transfer: null,
            });
          posts += 1;
          if (posts === 1)
            return Response.json({ error: 'unavailable' }, { status: 503 });
          const body = (await request.json()) as {
            bindingId: string;
            bindingRevision: number;
            expiresAt: number;
          };
          return Response.json({
            reference: {
              version: 'ixo.auth-action/1',
              id,
              accountId: 'account-1',
              bindingId: body.bindingId,
              bindingRevision: body.bindingRevision,
              revision: 1,
              digest: 'd'.repeat(64),
              url: `${HUB}/a/${id}`,
              expiresAt: body.expiresAt,
              title: 'Send your application',
            },
          });
        },
      },
    });
    const rows = new Map<string, unknown>();
    const kv: NonNullable<RuntimeContext['kv']> = {
      get: async (ns, k) => rows.get(`${ns}/${k}`),
      set: async (ns, k, v) => void rows.set(`${ns}/${k}`, v),
      update: async (ns, k, fn) => {
        const next = fn(structuredClone(rows.get(`${ns}/${k}`)));
        if (next === undefined) rows.delete(`${ns}/${k}`);
        else rows.set(`${ns}/${k}`, structuredClone(next));
        return next;
      },
      delete: async (ns, k) => void rows.delete(`${ns}/${k}`),
    };
    const keys: string[] = [];
    let message = 0;
    let tool = 0;
    const context = (): RuntimeContext =>
      makeRuntimeContext({
        config: { NETWORK: 'mainnet', BLOCKSYNC_GRAPHQL_URL: BLOCKSYNC },
        user: {
          did: DID,
          matrixUserId: '@user:test',
          ucanDelegation: { raw: 'delegation' },
        },
        session: {
          id: 'session-1',
          client: 'channel',
          requestId: `request-${message}`,
          runId: `run-${message}`,
          channel: {
            provider: 'meta',
            bindingId: 'binding-1',
            bindingRevision: 1,
          },
        },
        toolCallId: `tool-${++tool}`,
        kv,
        hubActions: {
          capabilities: () => client.capabilities(),
          options: () => Promise.reject(new Error('unused')),
          chainTransaction: () => Promise.reject(new Error('unused')),
          status: async () => ({ outcome: null, summary: null }),
          request: (input) => {
            keys.push(input.requestKey);
            return prepareHubAction(
              client,
              {
                reserve: (origin, operation, expiresAt) =>
                  store.reserve(origin, operation, expiresAt),
                record: (origin, reference: ActionReferenceV1) =>
                  store.record(origin, reference),
                byRequestKey: (key) => store.byRequestKey(key),
              },
              input,
            );
          },
        },
      });
    const form = new YomaPlugin()
      .getTools()
      .find((t) => t.name === 'yoma_form')!;
    const ref = { form: 'application', collectionId: '9787' };
    const act = async (args: Record<string, unknown>) =>
      (await form.handler({ ...ref, ...args }, context())) as Record<
        string,
        unknown
      >;
    await act({ action: 'next' });
    await act({
      action: 'answer',
      field: 'schema:name',
      reply: 'Lebo Mokoena',
    });
    await act({
      action: 'answer',
      field: 'schema:identifier',
      reply: '0001015800085',
    });
    await act({
      action: 'answer',
      field: 'schema:telephone',
      reply: '071 234 5678',
      value: '0712345678',
    });
    const send = async () => {
      expect((await act({ action: 'review' })).status).toBe('ready');
      message += 1;
      return act({ action: 'submit', confirmed: true });
    };
    expect(await send()).toMatchObject({ ok: false, retryable: true });
    expect(await send()).toMatchObject({ ok: true, status: 'prepared' });
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(await store.byRequestKey(keys[0]!)).toBeNull();
    expect((await store.byRequestKey(keys[1]!))?.id).toBe(id);
  });
});
