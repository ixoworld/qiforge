import { describe, expect, it, vi } from 'vitest';
import { AgentCardService } from './agent-card.service.js';
import { loadLocalAgentCard } from './local-card.js';
import {
  CARD_ENDPOINT,
  LOCAL_CARD_PATH,
  makeCardDocument,
  makeEntityDoc,
  ORACLE_ENTITY_DID,
} from './__test-fixtures__/oracle-payments-fixtures.js';

describe('AgentCardService', () => {
  it('resolves the card: entity → #acard resource → serviceEndpoint → services', async () => {
    const fetchCard = vi.fn(async () => makeCardDocument());
    const service = new AgentCardService({
      getEntity: async () => makeEntityDoc(),
      fetchCard,
    });

    const { card, error } = await service.getCard(ORACLE_ENTITY_DID);

    expect(fetchCard).toHaveBeenCalledWith(CARD_ENDPOINT);
    expect(error).toBeUndefined();
    expect(card).not.toBeNull();
    expect(card?.oracleEntityDid).toBe(ORACLE_ENTITY_DID);
    expect(card?.cardProof).toBe('card-proof-v1');
    expect(card?.services.map((s) => s.id)).toEqual([
      'tax-report',
      'quick-estimate',
    ]);
    expect(card?.services[0]?.price.amount).toBe(20);
  });

  it('getServices returns just the services array', async () => {
    const service = new AgentCardService({
      getEntity: async () => makeEntityDoc(),
      fetchCard: async () => makeCardDocument(),
    });
    const services = await service.getServices(ORACLE_ENTITY_DID);
    expect(services?.map((s) => s.id)).toEqual([
      'tax-report',
      'quick-estimate',
    ]);
  });

  it('reports no card and NO error when the entity publishes no #acard resource', async () => {
    const service = new AgentCardService({
      getEntity: async () => ({
        linkedResource: [{ type: 'settings', id: `${ORACLE_ENTITY_DID}#orz` }],
      }),
      fetchCard: async () => makeCardDocument(),
    });
    // Nothing published is an answer, not a failure — the only case the tools
    // may report as "this oracle has no services".
    expect(await service.getCard(ORACLE_ENTITY_DID)).toEqual({ card: null });
  });

  it('reports why the card is unavailable when the fetch fails', async () => {
    const service = new AgentCardService({
      getEntity: async () => makeEntityDoc(),
      fetchCard: async () => null,
    });
    const { card, error } = await service.getCard(ORACLE_ENTITY_DID);
    expect(card).toBeNull();
    expect(error).toMatch(/could not be downloaded/);
  });

  it('reports why the card is unavailable when the entity read throws', async () => {
    const service = new AgentCardService({
      getEntity: async () => {
        throw new Error('blocksync down');
      },
      fetchCard: async () => makeCardDocument(),
    });
    const { card, error } = await service.getCard(ORACLE_ENTITY_DID);
    expect(card).toBeNull();
    expect(error).toContain('blocksync down');
  });

  it('reports why the card is unavailable when its shape is invalid (empty services)', async () => {
    const service = new AgentCardService({
      getEntity: async () => makeEntityDoc(),
      fetchCard: async () => ({
        credentialSubject: { id: ORACLE_ENTITY_DID, name: 'X', services: [] },
      }),
    });
    const { card, error } = await service.getCard(ORACLE_ENTITY_DID);
    expect(card).toBeNull();
    expect(error).toMatch(/did not match the expected shape/);
  });

  it('reports why the card is unavailable when credentialSubject.id does not match the entity DID', async () => {
    const service = new AgentCardService({
      getEntity: async () => makeEntityDoc(),
      fetchCard: async () => makeCardDocument('did:ixo:entity:someone-else'),
    });
    const { card, error } = await service.getCard(ORACLE_ENTITY_DID);
    expect(card).toBeNull();
    expect(error).toContain('did:ixo:entity:someone-else');
  });

  it('returns null when a service is missing a numeric price.amount', async () => {
    const service = new AgentCardService({
      getEntity: async () => makeEntityDoc(),
      fetchCard: async () => ({
        credentialSubject: {
          id: ORACLE_ENTITY_DID,
          name: 'X',
          services: [
            {
              id: 'svc',
              name: 'Svc',
              price: { amount: 'free' },
              deliverables: 'thing',
            },
          ],
        },
      }),
    });
    expect((await service.getCard(ORACLE_ENTITY_DID)).card).toBeNull();
  });

  it('caches a resolved card for its TTL and re-resolves after expiry', async () => {
    let now = 1_000;
    const getEntity = vi.fn(async () => makeEntityDoc());
    const service = new AgentCardService({
      getEntity,
      fetchCard: async () => makeCardDocument(),
      clock: () => now,
    });

    await service.getCard(ORACLE_ENTITY_DID);
    await service.getCard(ORACLE_ENTITY_DID);
    expect(getEntity).toHaveBeenCalledTimes(1);

    // Advance past the 300s TTL.
    now += 300_001;
    await service.getCard(ORACLE_ENTITY_DID);
    expect(getEntity).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures (a transient miss retries next call)', async () => {
    const getEntity = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(makeEntityDoc());
    const service = new AgentCardService({
      getEntity,
      fetchCard: async () => makeCardDocument(),
    });

    expect((await service.getCard(ORACLE_ENTITY_DID)).card).toBeNull();
    const { card } = await service.getCard(ORACLE_ENTITY_DID);
    expect(card?.services).toHaveLength(2);
    expect(getEntity).toHaveBeenCalledTimes(2);
  });
});

describe('AgentCardService — local seed + drift guard', () => {
  const makeLogger = () => ({
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  });

  it('falls back to the local seed when on-chain resolution returns null', async () => {
    const service = new AgentCardService({
      getEntity: async () => null,
      fetchCard: async () => null,
    });
    const local = loadLocalAgentCard(LOCAL_CARD_PATH);
    service.setLocalSeed({
      oracleEntityDid: ORACLE_ENTITY_DID,
      cardProof: '',
      services: local.services,
    });

    const { card, error } = await service.getCard(ORACLE_ENTITY_DID);
    expect(error).toBeUndefined();
    expect(card?.oracleEntityDid).toBe(ORACLE_ENTITY_DID);
    expect(card?.services.map((s) => s.id)).toEqual([
      'tax-report',
      'quick-estimate',
    ]);
  });

  it('does not use the seed for a different entity DID', async () => {
    const service = new AgentCardService({
      getEntity: async () => null,
      fetchCard: async () => null,
    });
    service.setLocalSeed({
      oracleEntityDid: ORACLE_ENTITY_DID,
      cardProof: '',
      services: loadLocalAgentCard(LOCAL_CARD_PATH).services,
    });
    expect((await service.getCard('did:ixo:entity:other')).card).toBeNull();
  });

  it('prefers the on-chain card over the local seed once it resolves', async () => {
    const service = new AgentCardService({
      getEntity: async () => makeEntityDoc(),
      fetchCard: async () => makeCardDocument(),
    });
    service.setLocalSeed({
      oracleEntityDid: ORACLE_ENTITY_DID,
      cardProof: 'local-proof',
      services: [
        { id: 'stale', name: 'Stale', price: { amount: 1 }, deliverables: 'z' },
      ],
    });

    const { card } = await service.getCard(ORACLE_ENTITY_DID);
    expect(card?.cardProof).toBe('card-proof-v1');
    expect(card?.services.map((s) => s.id)).toEqual([
      'tax-report',
      'quick-estimate',
    ]);
  });

  it('warns once per on-chain card proof when the local seed disagrees on services', async () => {
    const logger = makeLogger();
    let now = 1_000;
    const service = new AgentCardService({
      getEntity: async () => makeEntityDoc(),
      fetchCard: async () => makeCardDocument(),
      logger,
      clock: () => now,
    });
    service.setLocalSeed({
      oracleEntityDid: ORACLE_ENTITY_DID,
      cardProof: '',
      services: [
        { id: 'stale', name: 'Stale', price: { amount: 1 }, deliverables: 'z' },
      ],
    });

    await service.getCard(ORACLE_ENTITY_DID);
    now += 300_001; // expire the cache → re-resolve the same on-chain proof
    await service.getCard(ORACLE_ENTITY_DID);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toMatch(/differs from the on-chain/);
  });

  it('does not warn when the local seed matches the on-chain services', async () => {
    const logger = makeLogger();
    const service = new AgentCardService({
      getEntity: async () => makeEntityDoc(),
      fetchCard: async () => makeCardDocument(),
      logger,
    });
    service.setLocalSeed({
      oracleEntityDid: ORACLE_ENTITY_DID,
      cardProof: '',
      services: loadLocalAgentCard(LOCAL_CARD_PATH).services,
    });

    await service.getCard(ORACLE_ENTITY_DID);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
