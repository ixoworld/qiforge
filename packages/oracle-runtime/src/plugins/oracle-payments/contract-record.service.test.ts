import { describe, expect, it, vi } from 'vitest';
import { ContractRecordService } from './contract-record.service.js';
import {
  makeContractRecord,
  USER_DID,
} from './__test-fixtures__/oracle-payments-fixtures.js';

const ENGINE_URL = 'https://engine.example';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('ContractRecordService', () => {
  it('returns the parsed record on 200 and sends the UCAN auth headers', async () => {
    const record = makeContractRecord();
    const fetchImpl = vi.fn(async () => jsonResponse(record));
    const service = new ContractRecordService({
      tokenProvider: async () => 'engine-token',
      fetchImpl,
    });

    const result = await service.lookup({
      engineUrl: ENGINE_URL,
      subscriberDid: USER_DID,
    });

    expect(result).toEqual({ record });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      `${ENGINE_URL}/v1/agents/contracts/for-oracle?subscriberDid=${encodeURIComponent(
        USER_DID,
      )}`,
    );
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer engine-token');
    expect(headers['X-Auth-Type']).toBe('ucan');
  });

  it('answers "no contract" — with no error — on 404', async () => {
    const service = new ContractRecordService({
      tokenProvider: async () => 'engine-token',
      fetchImpl: async () => new Response(null, { status: 404 }),
    });
    // The one lookup that genuinely establishes the user has no contract.
    expect(
      await service.lookup({ engineUrl: ENGINE_URL, subscriberDid: USER_DID }),
    ).toEqual({ record: null });
  });

  it('reports the engine status as an error on a 5xx, without caching', async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
    const service = new ContractRecordService({
      tokenProvider: async () => 'engine-token',
      fetchImpl,
      logger: { log: vi.fn(), error: vi.fn(), warn },
    });

    const { record, error } = await service.lookup({
      engineUrl: ENGINE_URL,
      subscriberDid: USER_DID,
    });
    expect(record).toBeNull();
    // Never mistakable for "no contract": the caller must be able to say why.
    expect(error).toContain('503');
    // Not cached: a second lookup hits the network again.
    await service.lookup({ engineUrl: ENGINE_URL, subscriberDid: USER_DID });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
  });

  it('reports the missing EVAL_ENGINE_URL as an error and warns (once)', async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn();
    const service = new ContractRecordService({
      tokenProvider: async () => 'engine-token',
      fetchImpl,
      logger: { log: vi.fn(), error: vi.fn(), warn },
    });

    const { record, error } = await service.lookup({
      engineUrl: undefined,
      subscriberDid: USER_DID,
    });
    expect(record).toBeNull();
    expect(error).toContain('EVAL_ENGINE_URL');
    await service.lookup({ engineUrl: undefined, subscriberDid: USER_DID });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports an error when no signing key is available (token provider yields null)', async () => {
    const fetchImpl = vi.fn();
    const service = new ContractRecordService({
      tokenProvider: async () => null,
      fetchImpl,
    });
    const { record, error } = await service.lookup({
      engineUrl: ENGINE_URL,
      subscriberDid: USER_DID,
    });
    expect(record).toBeNull();
    expect(error).toMatch(/signing key/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports the transport failure when the engine cannot be reached', async () => {
    const service = new ContractRecordService({
      tokenProvider: async () => 'engine-token',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const { record, error } = await service.lookup({
      engineUrl: ENGINE_URL,
      subscriberDid: USER_DID,
    });
    expect(record).toBeNull();
    expect(error).toContain('ECONNREFUSED');
  });

  it('caches a positive result per subscriber for the TTL', async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => jsonResponse(makeContractRecord()));
    const service = new ContractRecordService({
      tokenProvider: async () => 'engine-token',
      fetchImpl,
      clock: () => now,
    });

    await service.lookup({ engineUrl: ENGINE_URL, subscriberDid: USER_DID });
    await service.lookup({ engineUrl: ENGINE_URL, subscriberDid: USER_DID });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 300_001;
    await service.lookup({ engineUrl: ENGINE_URL, subscriberDid: USER_DID });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caches a 404 result (no contract) for the TTL', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const service = new ContractRecordService({
      tokenProvider: async () => 'engine-token',
      fetchImpl,
    });

    await service.lookup({ engineUrl: ENGINE_URL, subscriberDid: USER_DID });
    await service.lookup({ engineUrl: ENGINE_URL, subscriberDid: USER_DID });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('invalidate drops the cached entry so the next lookup re-queries', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(makeContractRecord()));
    const service = new ContractRecordService({
      tokenProvider: async () => 'engine-token',
      fetchImpl,
    });

    await service.lookup({ engineUrl: ENGINE_URL, subscriberDid: USER_DID });
    service.invalidate(USER_DID);
    await service.lookup({ engineUrl: ENGINE_URL, subscriberDid: USER_DID });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports an error on a malformed record body', async () => {
    const service = new ContractRecordService({
      tokenProvider: async () => 'engine-token',
      fetchImpl: async () => jsonResponse({ collectionId: 42 }),
    });
    const { record, error } = await service.lookup({
      engineUrl: ENGINE_URL,
      subscriberDid: USER_DID,
    });
    expect(record).toBeNull();
    expect(error).toMatch(/could not read/);
  });

  it('setTokenProvider wires a provider used by subsequent lookups', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(makeContractRecord()));
    const service = new ContractRecordService({ fetchImpl });
    // No provider yet → an error, no fetch.
    expect(
      (await service.lookup({ engineUrl: ENGINE_URL, subscriberDid: USER_DID }))
        .error,
    ).toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();

    service.setTokenProvider(async () => 'engine-token');
    const result = await service.lookup({
      engineUrl: ENGINE_URL,
      subscriberDid: USER_DID,
    });
    expect(result.record).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
