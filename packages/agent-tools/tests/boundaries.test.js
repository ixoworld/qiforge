import { expect, test } from 'vitest';
import {
  CATALOG_VERSION,
  SOURCE_ENVELOPE_VERSION,
  catalog,
  createAgentToolsHost,
  mcpTools,
  nativeTools,
} from '../src/index.js';

const instant = Date.parse('2026-10-24T12:00:00Z');
const facts = {
  userDid: 'did:ixo:alice',
  oracleDid: 'did:ixo:companion',
  network: 'devnet',
  sessionId: 'a',
  roomId: 'a',
  visibility: 'private',
  timezone: 'Asia/Singapore',
};
const grant = (tool, context = facts) => ({
  ...context,
  tool,
  expiresAt: '2026-10-24T13:00:00Z',
});
const receipt = (source, reference = 'record-1') => ({
  source,
  reference,
  revision: 'r1',
  observedAt: '2026-10-24T12:00:00Z',
  freshness: 'current',
});
const source = (value, evidence, context = facts) => ({
  version: 1,
  status: 'available',
  scope: { ...context },
  value,
  evidence,
});
const credits = () =>
  source(
    {
      lookupStatus: 'confirmed',
      amount: '9007199254740993.001',
      denomination: 'upay',
      decimals: 3,
      ledger: 'subscription_credits',
      network: 'devnet',
    },
    [receipt('subscriptions')],
  );
const operation = () =>
  source({ operationId: 'record-1', state: 'pending' }, [receipt('operation')]);
function fixture(name, adapter, options = {}) {
  const host = createAgentToolsHost({
    now: () => instant,
    adapters: { [name]: adapter },
    readGrants: (context) => [grant(name, context)],
    resourceAccess: () => true,
    ...options,
  });
  return { host, token: host.bindContext(facts) };
}
function latch() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

test('versions and frozen projections expose exactly the documented read descriptors', () => {
  expect(CATALOG_VERSION).toBe('1.0.0');
  expect(SOURCE_ENVELOPE_VERSION).toBe(1);
  for (const [index, tool] of nativeTools().entries()) {
    expect(Object.keys(tool).sort()).toEqual([
      'description',
      'effect',
      'inputSchema',
      'name',
    ]);
    expect(Object.keys(mcpTools()[index]).sort()).toEqual([
      'annotations',
      'description',
      'inputSchema',
      'name',
    ]);
    expect(tool.inputSchema).toBe(mcpTools()[index].inputSchema);
    expect(tool.inputSchema).toBe(catalog[index].inputSchema);
    expect(Object.isFrozen(tool.inputSchema)).toBe(true);
  }
  expect(() => nativeTools().push({})).toThrow(TypeError);
});

test('scope and grant bindings include every host field', async () => {
  for (const [field, value] of Object.entries({
    userDid: 'other',
    oracleDid: 'other',
    network: 'mainnet',
    sessionId: 'b',
    roomId: 'b',
    visibility: 'shared',
    timezone: 'UTC',
  })) {
    const raw = credits();
    raw.scope[field] = value;
    const scoped = fixture('ixo_credits_get', () => raw);
    expect(
      await scoped.host.invoke(scoped.token, 'ixo_credits_get', {}),
    ).toEqual({ status: 'unauthorized', reason: 'scope_denied' });
    const granted = fixture('ixo_credits_get', () => credits(), {
      readGrants: () => [
        grant('ixo_credits_get', { ...facts, [field]: value }),
      ],
    });
    expect(
      await granted.host.invoke(granted.token, 'ixo_credits_get', {}),
    ).toEqual({ status: 'unauthorized', reason: 'grant_missing' });
  }
});

test('malformed grants fail closed even alongside a valid matching grant', async () => {
  const valid = grant('ixo_credits_get');
  const legacy = { ...valid };
  delete legacy.timezone;
  for (const malformed of [
    null,
    {},
    legacy,
    { ...valid, injected: true },
    { ...valid, expiresAt: 0 },
    { ...valid, expiresAt: 'nonsense' },
    { ...valid, expiresAt: '2026-10-24T13:00:00' },
    { ...valid, tool: 'ixo_send' },
    { ...valid, visibility: 'public' },
  ]) {
    let calls = 0;
    const { host, token } = fixture(
      'ixo_credits_get',
      () => {
        calls++;
        return credits();
      },
      { readGrants: () => [valid, malformed] },
    );
    expect(await host.invoke(token, 'ixo_credits_get', {})).toEqual({
      status: 'unavailable',
      reason: 'authorization_unavailable',
      retryable: true,
    });
    expect(calls).toBe(0);
  }
});

test('a grant that expires at the disclosure clock sample suppresses the result', async () => {
  const expiry = instant + 1000;
  let resourcesChecked = false;
  let finalGrantRead = false;
  let sampledFinalGrant = false;
  const { host, token } = fixture('ixo_operation_get', operation, {
    readGrants: (context) => {
      if (resourcesChecked) finalGrantRead = true;
      return [
        {
          ...grant('ixo_operation_get', context),
          expiresAt: new Date(expiry).toISOString(),
        },
      ];
    },
    resourceAccess: () => {
      resourcesChecked = true;
      return true;
    },
    now: () => {
      if (!finalGrantRead) return instant;
      if (!sampledFinalGrant) {
        sampledFinalGrant = true;
        return expiry - 1;
      }
      return expiry;
    },
  });
  expect(
    await host.invoke(token, 'ixo_operation_get', { operationId: 'record-1' }),
  ).toEqual({
    status: 'unauthorized',
    reason: 'grant_expired',
  });
});

test('any current matching grant keeps authority available regardless of grant order', async () => {
  const expired = {
    ...grant('ixo_credits_get'),
    expiresAt: new Date(instant - 1).toISOString(),
  };
  const current = {
    ...grant('ixo_credits_get'),
    expiresAt: new Date(instant + 1).toISOString(),
  };
  for (const grants of [
    [expired, current],
    [current, expired],
  ]) {
    const { host, token } = fixture('ixo_credits_get', credits, {
      readGrants: () => grants,
    });
    expect((await host.invoke(token, 'ixo_credits_get', {})).status).toBe(
      'available',
    );
  }
});

test('grants are owned before the host clock callback can mutate their original binding', async () => {
  const grants = [grant('ixo_credits_get')];
  let calls = 0;
  const { host, token } = fixture(
    'ixo_credits_get',
    () => {
      calls++;
      return credits();
    },
    {
      readGrants: () => grants,
      now: () => {
        grants[0].expiresAt = '2020-01-01T00:00:00Z';
        return instant;
      },
    },
  );
  const result = await host.invoke(token, 'ixo_credits_get', {});
  expect(result.reason).toBe('grant_expired');
  expect(calls).toBe(1);
  expect(result).not.toHaveProperty('value');
});

test('parsed response is owned before post-retrieval authorization can mutate it', async () => {
  const raw = credits();
  let reads = 0;
  const { host, token } = fixture('ixo_credits_get', () => raw, {
    readGrants: () => {
      if (++reads === 2) {
        raw.scope.userDid = 'did:ixo:mallory';
        raw.value.amount = '999';
        raw.evidence[0].reference = 'changed';
      }
      return [grant('ixo_credits_get')];
    },
  });
  const result = await host.invoke(token, 'ixo_credits_get', {});
  expect(result.status).toBe('available');
  expect(result.value.amount).toBe('9007199254740993.001');
  expect(result.evidence[0].reference).toBe('record-1');
  expect(Object.isFrozen(raw)).toBe(false);
});

test('a mismatched source cannot be repaired by mutation during authorization', async () => {
  const raw = credits();
  raw.scope.timezone = 'UTC';
  let reads = 0;
  const { host, token } = fixture('ixo_credits_get', () => raw, {
    readGrants: () => {
      if (++reads === 2) raw.scope.timezone = facts.timezone;
      return [grant('ixo_credits_get')];
    },
  });
  expect((await host.invoke(token, 'ixo_credits_get', {})).reason).toBe(
    'scope_denied',
  );
});

test('resource callback receives frozen receipts and cannot mutate a validated answer', async () => {
  const raw = operation();
  const { host, token } = fixture('ixo_operation_get', () => raw, {
    resourceAccess: (context, evidence) => {
      expect(() => {
        context.roomId = 'b';
      }).toThrow(TypeError);
      expect(() => {
        evidence.reference = 'other';
      }).toThrow(TypeError);
      raw.value.state = 'completed';
      raw.evidence[0].reference = 'other';
      return true;
    },
  });
  const result = await host.invoke(token, 'ixo_operation_get', {
    operationId: 'record-1',
  });
  expect(result.value.state).toBe('pending');
  expect(result.evidence[0].reference).toBe('record-1');
  expect(() => {
    result.value.state = 'failed';
  }).toThrow(TypeError);
  expect(() => {
    result.evidence[0].revision = 'changed';
  }).toThrow(TypeError);
});

test('revocation during awaited resource authorization suppresses the value', async () => {
  const started = latch();
  const finish = latch();
  let active = true;
  const { host, token } = fixture('ixo_operation_get', operation, {
    readGrants: () => (active ? [grant('ixo_operation_get')] : []),
    resourceAccess: async () => {
      started.release();
      await finish.promise;
      return true;
    },
  });
  const pending = host.invoke(token, 'ixo_operation_get', {
    operationId: 'record-1',
  });
  await started.promise;
  active = false;
  finish.release();
  expect(await pending).toEqual({
    status: 'unauthorized',
    reason: 'grant_missing',
  });
});

test('evidence that expires during a resource check cannot be disclosed', async () => {
  let at = instant;
  const { host, token } = fixture('ixo_operation_get', operation, {
    now: () => at,
    resourceAccess: async () => {
      at += 300001;
      return true;
    },
  });
  expect(
    await host.invoke(token, 'ixo_operation_get', { operationId: 'record-1' }),
  ).toEqual({
    status: 'unavailable',
    reason: 'evidence_stale',
    retryable: true,
  });
});

test('quote expiry is checked again after the final authority await', async () => {
  let reads = 0;
  let at = instant;
  const quote = {
    quoteId: 'q1',
    quoteScope: 'corridor',
    asset: 'USDC',
    corridor: 'ZA-bank',
    amount: '10.00',
    payoutAmount: '180.18',
    payoutCurrency: 'ZAR',
    rate: '18.20',
    fee: '0.10',
    denomination: 'USDC',
    expiresAt: '2026-10-24T12:01:00Z',
  };
  const { host, token } = fixture(
    'ixo_offramp_quote',
    { reviewed: true, invoke: () => source(quote, [receipt('offramp', 'q1')]) },
    {
      now: () => at,
      readGrants: async () => {
        if (++reads === 3) at = instant + 60000;
        return [grant('ixo_offramp_quote')];
      },
    },
  );
  expect(
    await host.invoke(token, 'ixo_offramp_quote', {
      asset: 'USDC',
      amount: '10.00',
      corridor: 'ZA-bank',
    }),
  ).toEqual({
    status: 'unavailable',
    reason: 'quote_expired',
    retryable: true,
  });
});

test('quote review remains bound to the original adapter descriptor', async () => {
  let original = 0;
  let replacement = 0;
  const descriptor = {
    reviewed: true,
    invoke: () => {
      original++;
      return { version: 1, status: 'unavailable' };
    },
  };
  const { host, token } = fixture('ixo_offramp_quote', descriptor);
  descriptor.invoke = () => {
    replacement++;
    throw new Error('replacement');
  };
  descriptor.reviewed = false;
  expect(
    (
      await host.invoke(token, 'ixo_offramp_quote', {
        asset: 'USDC',
        amount: '1',
        corridor: 'ZA-bank',
      })
    ).reason,
  ).toBe('source_unavailable');
  expect(original).toBe(1);
  expect(replacement).toBe(0);
});

test('inputs are copied before authority awaits and frozen before adapter calls', async () => {
  const input = { query: 'original', when: 'yesterday' };
  const { host, token } = fixture(
    'ixo_files_find',
    ({ input: received }) => {
      expect(received.query).toBe('original');
      expect(received.when).toEqual({
        calendarDate: '2026-10-23',
        timezone: 'Asia/Singapore',
      });
      expect(() => {
        received.when.timezone = 'UTC';
      }).toThrow(TypeError);
      return { version: 1, status: 'unavailable' };
    },
    {
      readGrants: () => {
        input.query = 'changed';
        return [grant('ixo_files_find')];
      },
    },
  );
  expect((await host.invoke(token, 'ixo_files_find', input)).reason).toBe(
    'source_unavailable',
  );
});

test('concurrent users retain separate context, response, authority and output snapshots', async () => {
  const started = latch();
  const finish = latch();
  const bob = { ...facts, userDid: 'did:ixo:bob', sessionId: 'b', roomId: 'b' };
  const host = createAgentToolsHost({
    now: () => instant,
    readGrants: (context) => [grant('ixo_concept_get', context)],
    adapters: {
      ixo_concept_get: async ({ context }) => {
        if (context.userDid === facts.userDid) {
          started.release();
          await finish.promise;
        }
        return source(
          { text: context.userDid },
          [receipt('canonical_document')],
          context,
        );
      },
    },
  });
  const aliceResult = host.invoke(host.bindContext(facts), 'ixo_concept_get', {
    concept: 'Topic',
  });
  await started.promise;
  const bobResult = await host.invoke(
    host.bindContext(bob),
    'ixo_concept_get',
    { concept: 'Topic' },
  );
  finish.release();
  expect((await aliceResult).value.text).toBe(facts.userDid);
  expect(bobResult.value.text).toBe(bob.userDid);
});

test('strict v1 source envelopes reject legacy versions, unknown keys and incomplete scope', async () => {
  const legacy = credits();
  delete legacy.version;
  const missingVisibility = credits();
  delete missingVisibility.scope.visibility;
  for (const raw of [
    legacy,
    { ...credits(), version: 2 },
    { ...credits(), secret: 'credential' },
    missingVisibility,
    { version: 1, status: 'unavailable', message: 'secret' },
    { version: 1, status: 'unauthorized', scope: facts },
    { ...credits(), value: { ...credits().value, injected: true } },
  ]) {
    const { host, token } = fixture('ixo_credits_get', () => raw);
    expect(await host.invoke(token, 'ixo_credits_get', {})).toEqual({
      status: 'unavailable',
      reason: 'invalid_source_response',
      retryable: false,
    });
  }
});

test('source errors return only safe refusal fields and tolerate arbitrary unknown results', async () => {
  for (const [raw, reason] of [
    [{ version: 1, status: 'unauthorized' }, 'source_denied'],
    [{ version: 1, status: 'unavailable' }, 'source_unavailable'],
    [undefined, 'invalid_source_response'],
    [null, 'invalid_source_response'],
    [new Error('secret'), 'invalid_source_response'],
    [Symbol('secret'), 'invalid_source_response'],
  ]) {
    const { host, token } = fixture('ixo_credits_get', () => raw);
    const result = await host.invoke(token, 'ixo_credits_get', {});
    expect(result.reason).toBe(reason);
    expect(result).not.toHaveProperty('value');
    expect(JSON.stringify(result)).not.toContain('secret');
  }
});

test('accessors, cycles, unsupported prototypes and non-data source values fail without getter execution', async () => {
  let calls = 0;
  const getter = credits();
  Object.defineProperty(getter.value, 'amount', {
    get() {
      calls++;
      return '1';
    },
    enumerable: true,
  });
  const cyclic = credits();
  cyclic.value.loop = cyclic;
  for (const raw of [
    getter,
    cyclic,
    { ...credits(), value: new Map() },
    { ...credits(), evidence: [new Date()] },
    { ...credits(), value: { ...credits().value, amount: () => '1' } },
  ]) {
    const { host, token } = fixture('ixo_credits_get', () => raw);
    expect((await host.invoke(token, 'ixo_credits_get', {})).reason).toBe(
      'invalid_source_response',
    );
  }
  expect(calls).toBe(0);
});

test('authorization revocation takes priority over an invalid returned source', async () => {
  let active = true;
  const { host, token } = fixture(
    'ixo_credits_get',
    () => {
      active = false;
      return new Error('secret');
    },
    { readGrants: () => (active ? [grant('ixo_credits_get')] : []) },
  );
  expect(await host.invoke(token, 'ixo_credits_get', {})).toEqual({
    status: 'unauthorized',
    reason: 'grant_missing',
  });
});

test('timestamps require an explicit offset and valid calendar date', async () => {
  for (const timestamp of [
    '2026-10-24T12:00:00',
    'October 24, 2026 12:00 UTC',
    '2026-02-30T12:00:00Z',
  ]) {
    const raw = credits();
    raw.evidence[0].observedAt = timestamp;
    const observed = fixture('ixo_credits_get', () => raw);
    expect(
      (await observed.host.invoke(observed.token, 'ixo_credits_get', {}))
        .reason,
    ).toBe('invalid_evidence');
    const expired = fixture('ixo_credits_get', credits, {
      readGrants: () => [{ ...grant('ixo_credits_get'), expiresAt: timestamp }],
    });
    expect(
      (await expired.host.invoke(expired.token, 'ixo_credits_get', {})).reason,
    ).toBe('authorization_unavailable');
  }
});

test('caller claims about file absence are ignored and malformed claims rejected', async () => {
  const coverage = [
    { source: 'vfs', state: 'partial', reference: 'scan', revision: 'r1' },
    { source: 'attachment', state: 'unavailable' },
  ];
  for (const absenceConfirmed of [true, false, undefined]) {
    const value = {
      matches: [],
      coverage,
      ...(absenceConfirmed === undefined ? {} : { absenceConfirmed }),
    };
    const { host, token } = fixture('ixo_files_find', () =>
      source(value, [receipt('vfs', 'scan')]),
    );
    expect(
      (await host.invoke(token, 'ixo_files_find', { query: 'missing' })).value
        .absenceConfirmed,
    ).toBe(false);
  }
  const malformed = fixture('ixo_files_find', () =>
    source({ matches: [], coverage, absenceConfirmed: 'yes' }, [
      receipt('vfs', 'scan'),
    ]),
  );
  expect(
    (
      await malformed.host.invoke(malformed.token, 'ixo_files_find', {
        query: 'missing',
      })
    ).reason,
  ).toBe('invalid_source_response');
});

test('shared contexts can read public concepts with their own seven-field grant and scope', async () => {
  const shared = { ...facts, visibility: 'shared' };
  const host = createAgentToolsHost({
    now: () => instant,
    readGrants: (context) => [grant('ixo_concept_get', context)],
    adapters: {
      ixo_concept_get: ({ context }) =>
        source(
          { text: 'Canonical explanation' },
          [receipt('canonical_document')],
          context,
        ),
    },
  });
  expect(
    (
      await host.invoke(host.bindContext(shared), 'ixo_concept_get', {
        concept: 'Topic',
      })
    ).status,
  ).toBe('available');
});
