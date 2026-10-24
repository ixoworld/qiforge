import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
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
  sessionId: 'session-a',
  roomId: 'room-a',
  visibility: 'private',
  timezone: 'Asia/Singapore',
};
const scope = (context = facts) => ({ ...context });
const grant = (tool, overrides = {}) => ({
  ...scope(),
  tool,
  expiresAt: '2026-10-24T13:00:00Z',
  ...overrides,
});
const evidence = (source, overrides = {}) => ({
  source,
  reference: 'record-1',
  revision: 'rev-1',
  observedAt: '2026-10-24T12:00:00Z',
  freshness: 'current',
  ...overrides,
});
const response = (value, source, overrides = {}) => ({
  version: 1,
  status: 'available',
  scope: scope(),
  value,
  evidence: [evidence(source)],
  ...overrides,
});
const credits = (overrides = {}) => ({
  lookupStatus: 'confirmed',
  amount: '123456789012345678901.001',
  denomination: 'upay',
  decimals: 3,
  ledger: 'subscription_credits',
  network: 'devnet',
  ...overrides,
});
const coverage = (source, state = 'complete') => ({
  source,
  state,
  ...(state === 'unavailable'
    ? {}
    : { reference: `${source}-search`, revision: 'rev-1' }),
});
const fileResponse = (
  matches = [],
  sources = [coverage('vfs'), coverage('attachment')],
) =>
  response({ matches, coverage: sources }, 'vfs', {
    evidence: [
      ...sources
        .filter((item) => item.state !== 'unavailable')
        .map(({ source, reference, revision }) =>
          evidence(source, { reference, revision }),
        ),
      ...matches.map(({ source, reference, revision }) =>
        evidence(source, { reference, revision }),
      ),
    ],
  });
const quote = (overrides = {}) => ({
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
  ...overrides,
});
const quoteResponse = (overrides = {}) =>
  response(quote(overrides), 'offramp', {
    evidence: [evidence('offramp', { reference: 'q1' })],
  });
function fixture(name, adapter, options = {}) {
  const { reviewedQuoteAdapter, ...hostOptions } = options;
  const boundAdapter =
    name === 'ixo_offramp_quote'
      ? reviewedQuoteAdapter
        ? { reviewed: true, invoke: adapter }
        : undefined
      : adapter;
  const host = createAgentToolsHost({
    now: () => instant,
    readGrants: async (context) => [grant(name, context)],
    adapters: { [name]: boundAdapter },
    resourceAccess: async () => true,
    ...hostOptions,
  });
  return { host, token: host.bindContext(facts) };
}

test('native and MCP definitions have identical strict schemas from one immutable catalog', () => {
  const native = nativeTools();
  const mcp = mcpTools();
  assert.deepEqual(
    native.map(({ name, inputSchema }) => ({ name, inputSchema })),
    mcp.map(({ name, inputSchema }) => ({ name, inputSchema })),
  );
  assert.equal(native.length, 10);
  for (const tool of catalog) {
    for (const branch of tool.inputSchema.anyOf ?? [tool.inputSchema])
      assert.equal(branch.additionalProperties, false);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.effect, 'read');
    assert.equal(
      mcp.find((item) => item.name === tool.name).annotations.readOnlyHint,
      true,
    );
  }
  assert.throws(() => {
    catalog[0].inputSchema.additionalProperties = true;
  }, TypeError);
  assert.equal(
    catalog.some(({ name }) => /create|execute|send|write/.test(name)),
    false,
  );
});

test('a forged or cross-host context cannot dispatch or discover', async () => {
  const { host, token } = fixture('ixo_credits_get', () => {
    throw new Error('must not run');
  });
  assert.deepEqual(await host.invoke({ ...facts }, 'ixo_credits_get', {}), {
    status: 'unauthorized',
    reason: 'invalid_context',
  });
  assert.equal((await host.discover({})).reason, 'invalid_context');
  const other = createAgentToolsHost();
  assert.equal(
    (await other.invoke(token, 'ixo_credits_get', {})).reason,
    'invalid_context',
  );
  assert.deepEqual(Object.keys(token), []);
});

test('model authority fields and unknown tool names never reach an adapter', async () => {
  let calls = 0;
  const { host, token } = fixture('ixo_credits_get', () => {
    calls++;
  });
  for (const field of [
    'userDid',
    'network',
    'grants',
    'url',
    'ownerDid',
    'oracleDid',
    'namespace',
    'consent',
  ]) {
    assert.equal(
      (await host.invoke(token, 'ixo_credits_get', { [field]: 'forged' }))
        .reason,
      'invalid_arguments',
    );
  }
  for (const name of [
    'ixo_offramp_create',
    'ixo_wallet_send',
    'toString',
    '__proto__',
  ])
    assert.equal((await host.invoke(token, name, {})).reason, 'unknown_tool');
  assert.equal(calls, 0);
});

test('no grants, expired grants, and authorization errors fail closed', async () => {
  const adapter = () => {
    throw new Error('must not run');
  };
  for (const [readGrants, reason] of [
    [async () => [], 'grant_missing'],
    [
      async () => [
        grant('ixo_credits_get', { expiresAt: '2026-10-23T12:00:00Z' }),
      ],
      'grant_expired',
    ],
    [
      async () => {
        throw new Error('secret token');
      },
      'authorization_unavailable',
    ],
  ]) {
    const { host, token } = fixture('ixo_credits_get', adapter, { readGrants });
    assert.equal(
      (await host.invoke(token, 'ixo_credits_get', {})).reason,
      reason,
    );
  }
});

test('grant bindings cannot cross users, oracles, networks, sessions, or rooms', async () => {
  for (const key of [
    'userDid',
    'oracleDid',
    'network',
    'sessionId',
    'roomId',
  ]) {
    const { host, token } = fixture(
      'ixo_credits_get',
      () => {
        throw new Error('must not run');
      },
      {
        readGrants: async () => [grant('ixo_credits_get', { [key]: 'other' })],
      },
    );
    assert.equal(
      (await host.invoke(token, 'ixo_credits_get', {})).reason,
      'grant_missing',
      key,
    );
  }
});

test('revocation after discovery blocks the next invocation', async () => {
  let grants = [grant('ixo_credits_get')];
  let calls = 0;
  const { host, token } = fixture(
    'ixo_credits_get',
    () => {
      calls++;
    },
    { readGrants: async () => grants },
  );
  assert.deepEqual((await host.discover(token)).tools, ['ixo_credits_get']);
  grants = [];
  assert.equal(
    (await host.invoke(token, 'ixo_credits_get', {})).reason,
    'grant_missing',
  );
  assert.equal(calls, 0);
});

test('revocation during retrieval suppresses the returned data', async () => {
  let grants = [grant('ixo_credits_get')];
  const { host, token } = fixture(
    'ixo_credits_get',
    () => {
      grants = [];
      return response(credits(), 'subscriptions');
    },
    { readGrants: async () => grants },
  );
  const result = await host.invoke(token, 'ixo_credits_get', {});
  assert.equal(result.reason, 'grant_missing');
  assert.equal('value' in result, false);
});

test('host facts are copied and frozen before adapters see them', async () => {
  const original = { ...facts };
  let observed;
  const { host } = fixture('ixo_credits_get', ({ context }) => {
    observed = context;
    return response(credits(), 'subscriptions');
  });
  const token = host.bindContext(original);
  original.userDid = 'did:ixo:mallory';
  assert.equal(
    (await host.invoke(token, 'ixo_credits_get', {})).status,
    'available',
  );
  assert.equal(observed.userDid, 'did:ixo:alice');
  assert.throws(() => {
    observed.userDid = 'forged';
  }, TypeError);
});

test('absent service adapters remain not_integrated and undiscoverable', async () => {
  const host = createAgentToolsHost({
    now: () => instant,
    readGrants: async () => catalog.map(({ name }) => grant(name)),
  });
  const token = host.bindContext(facts);
  assert.deepEqual((await host.discover(token)).tools, []);
  for (const [name, args] of [
    ['ixo_account_get', {}],
    ['ixo_concept_get', { concept: 'Topic' }],
    ['ixo_error_explain', { errorId: 'err-1' }],
  ]) {
    assert.equal(
      (await host.invoke(token, name, args)).reason,
      'not_integrated',
    );
  }
});

test('confirmed credits preserve exact amount, ledger, denomination, and selected network', async () => {
  const { host, token } = fixture('ixo_credits_get', () =>
    response(credits(), 'subscriptions'),
  );
  const result = await host.invoke(token, 'ixo_credits_get', {});
  assert.equal(result.status, 'available');
  assert.deepEqual(result.value, {
    amount: '123456789012345678901.001',
    denomination: 'upay',
    decimals: 3,
    ledger: 'subscription_credits',
    network: 'devnet',
  });
  assert.equal(result.evidence[0].network, 'devnet');
  assert.equal(result.evidence[0].freshness, 'current');
});

test('ambiguous subscription zeros stay unavailable while explicitly confirmed zero is available', async () => {
  for (const value of [
    { totalCredits: 0, status: 'active' },
    { totalCredits: 0, status: 'processing' },
    credits({ lookupStatus: 'failed', amount: '0' }),
    credits({ lookupStatus: 'unknown', amount: '0' }),
  ]) {
    const { host, token } = fixture('ixo_credits_get', () =>
      response(value, 'subscriptions'),
    );
    const result = await host.invoke(token, 'ixo_credits_get', {});
    assert.equal(result.reason, 'ambiguous_balance');
    assert.equal('value' in result, false);
  }
  const { host, token } = fixture('ixo_credits_get', () =>
    response(credits({ amount: '0' }), 'subscriptions'),
  );
  assert.equal(
    (await host.invoke(token, 'ixo_credits_get', {})).value.amount,
    '0',
  );
});

test('numeric or incomplete credit amounts are not accepted', async () => {
  for (const value of [
    credits({ amount: 4 }),
    credits({ ledger: '' }),
    credits({ denomination: 'uixo' }),
    credits({ decimals: 6 }),
    credits({ decimals: -1 }),
    credits({ amount: '1e9' }),
  ]) {
    const { host, token } = fixture('ixo_credits_get', () =>
      response(value, 'subscriptions'),
    );
    assert.equal(
      (await host.invoke(token, 'ixo_credits_get', {})).reason,
      'invalid_source_response',
    );
  }
});

test('account results require a verified root IXO account, not a subscription admin or unsupported wallet binding', async () => {
  const { host, token } = fixture('ixo_account_get', () =>
    response(
      { adminAddress: 'ixo-admin', network: 'devnet' },
      'account_binding',
    ),
  );
  assert.equal(
    (await host.invoke(token, 'ixo_account_get', {})).reason,
    'invalid_source_response',
  );
  const unsupported = fixture('ixo_account_get', () =>
    response(
      {
        address: 'ixo-verified',
        binding: 'verified_wallet',
        network: 'devnet',
      },
      'account_binding',
    ),
  );
  assert.equal(
    (await unsupported.host.invoke(unsupported.token, 'ixo_account_get', {}))
      .reason,
    'invalid_source_response',
  );
  const valid = fixture('ixo_account_get', () =>
    response(
      {
        address: 'ixo-verified',
        addressType: 'ixo_account',
        binding: 'verified_root_did',
        network: 'devnet',
      },
      'account_binding',
    ),
  );
  assert.equal(
    (await valid.host.invoke(valid.token, 'ixo_account_get', {})).value.address,
    'ixo-verified',
  );
});

test('cross-scope service responses and a different balance network are denied', async () => {
  for (const key of [
    'userDid',
    'oracleDid',
    'network',
    'sessionId',
    'roomId',
  ]) {
    const { host, token } = fixture('ixo_credits_get', () =>
      response(credits(), 'subscriptions', {
        scope: { ...scope(), [key]: 'other' },
      }),
    );
    assert.equal(
      (await host.invoke(token, 'ixo_credits_get', {})).reason,
      'scope_denied',
    );
  }
  const { host, token } = fixture('ixo_credits_get', () =>
    response(credits({ network: 'mainnet' }), 'subscriptions'),
  );
  assert.equal(
    (await host.invoke(token, 'ixo_credits_get', {})).reason,
    'scope_denied',
  );
});

test('missing, invalid, stale, and future evidence cannot support an available claim', async () => {
  for (const [items, reason] of [
    [[], 'evidence_missing'],
    [[evidence('personal_memory')], 'invalid_evidence'],
    [[evidence('subscriptions', { revision: '' })], 'invalid_evidence'],
    [[evidence('subscriptions', { observedAt: 'bad' })], 'invalid_evidence'],
    [
      [evidence('subscriptions', { observedAt: '2026-10-24T11:00:00Z' })],
      'evidence_stale',
    ],
    [
      [evidence('subscriptions', { observedAt: '2026-10-24T13:00:00Z' })],
      'evidence_stale',
    ],
    [
      [evidence('subscriptions', { freshness: 'historical' })],
      'evidence_stale',
    ],
    [[evidence('subscriptions', { freshness: 'unknown' })], 'evidence_stale'],
  ]) {
    const { host, token } = fixture('ixo_credits_get', () =>
      response(credits(), 'subscriptions', { evidence: items }),
    );
    const result = await host.invoke(token, 'ixo_credits_get', {});
    assert.equal(result.reason, reason);
    assert.equal('value' in result, false);
  }
});

test('adapter failure returns no exception text, credentials, value, or invented zero', async () => {
  const { host, token } = fixture('ixo_credits_get', () => {
    throw new Error('credential=secret');
  });
  assert.deepEqual(await host.invoke(token, 'ixo_credits_get', {}), {
    status: 'unavailable',
    reason: 'upstream_failed',
    retryable: true,
  });
});

test('shared rooms cannot discover or call personal tools', async () => {
  let calls = 0;
  const { host } = fixture('ixo_memory_personal_search', () => {
    calls++;
  });
  const token = host.bindContext({ ...facts, visibility: 'shared' });
  assert.deepEqual((await host.discover(token)).tools, []);
  assert.equal(
    (
      await host.invoke(token, 'ixo_memory_personal_search', {
        query: 'private medical note',
      })
    ).reason,
    'disclosure_denied',
  );
  assert.equal(calls, 0);
});

test('personal and oracle memory use distinct adapters and evidence sources', async () => {
  const calls = [];
  const host = createAgentToolsHost({
    now: () => instant,
    readGrants: async () => [
      grant('ixo_memory_personal_search'),
      grant('ixo_memory_oracle_search'),
    ],
    resourceAccess: async () => true,
    adapters: {
      ixo_memory_personal_search: ({ context, input }) => {
        calls.push([
          context.userDid,
          context.oracleDid,
          input.query,
          'personal',
        ]);
        return response(
          {
            facts: [
              { text: 'Prefers tea', reference: 'record-1', revision: 'rev-1' },
            ],
          },
          'personal_memory',
        );
      },
      ixo_memory_oracle_search: () =>
        response(
          {
            knowledge: [
              {
                text: 'Public procedure',
                reference: 'record-1',
                revision: 'rev-1',
              },
            ],
            visibility: 'public',
          },
          'oracle_knowledge',
        ),
    },
  });
  const token = host.bindContext(facts);
  assert.equal(
    (
      await host.invoke(token, 'ixo_memory_personal_search', {
        query: 'my preference',
      })
    ).value.facts[0].text,
    'Prefers tea',
  );
  assert.equal(
    (
      await host.invoke(token, 'ixo_memory_oracle_search', {
        query: 'procedure',
      })
    ).value.knowledge[0].text,
    'Public procedure',
  );
  assert.deepEqual(calls, [
    ['did:ixo:alice', 'did:ixo:companion', 'my preference', 'personal'],
  ]);
  assert.equal(
    (
      await host.invoke(token, 'ixo_memory_personal_search', {
        query: 'x',
        knowledge_level: 'both',
      })
    ).reason,
    'invalid_arguments',
  );
});

test('private oracle knowledge is suppressed in a shared room', async () => {
  const { host } = fixture('ixo_memory_oracle_search', () =>
    response({ knowledge: [], visibility: 'private' }, 'oracle_knowledge', {
      scope: { ...facts, visibility: 'shared' },
    }),
  );
  const token = host.bindContext({ ...facts, visibility: 'shared' });
  assert.equal(
    (
      await host.invoke(token, 'ixo_memory_oracle_search', {
        query: 'procedure',
      })
    ).reason,
    'disclosure_denied',
  );
});

test('incomplete file coverage cannot establish absence', async () => {
  for (const state of ['partial', 'not_indexed', 'unavailable']) {
    const { host, token } = fixture('ixo_files_find', () =>
      fileResponse([], [coverage('vfs'), coverage('attachment', state)]),
    );
    const result = await host.invoke(token, 'ixo_files_find', {
      query: 'budget PDF',
    });
    assert.equal(result.status, 'available');
    assert.equal(result.value.absenceConfirmed, false);
    assert.equal(result.value.coverage[1].state, state);
  }
  const { host, token } = fixture('ixo_files_find', () => fileResponse());
  assert.equal(
    (await host.invoke(token, 'ixo_files_find', { query: 'budget PDF' })).value
      .absenceConfirmed,
    true,
  );
});

test('every searched file source requires its exact coverage receipt before absence or partial results can be disclosed', async () => {
  for (const source of ['vfs', 'attachment']) {
    for (const state of ['complete', 'partial', 'not_indexed']) {
      for (const defect of ['missing', 'wrong-reference', 'wrong-revision']) {
        const raw = fileResponse(
          [],
          [coverage('vfs'), coverage('attachment', state)],
        );
        if (defect === 'missing')
          raw.evidence = raw.evidence.filter((item) => item.source !== source);
        else
          raw.evidence.find((item) => item.source === source)[
            defect === 'wrong-reference' ? 'reference' : 'revision'
          ] = 'unrelated';
        const { host, token } = fixture('ixo_files_find', () => raw);
        const result = await host.invoke(token, 'ixo_files_find', {
          query: 'budget PDF',
        });
        assert.equal(
          result.reason,
          'evidence_missing',
          `${source} ${state} ${defect}`,
        );
        assert.equal('value' in result, false);
      }
    }
  }
});

test('coverage cannot contradict matches, receipts, or itself', async () => {
  const match = {
    source: 'attachment',
    reference: 'photo-1',
    revision: 'rev-1',
    name: 'photo.jpg',
    uploadedAt: '2026-10-23T10:00:00Z',
    indexedText: false,
  };
  const responses = [
    fileResponse(
      [match],
      [coverage('vfs'), coverage('attachment', 'unavailable')],
    ),
    fileResponse([], [coverage('vfs'), coverage('vfs', 'partial')]),
    {
      ...fileResponse(
        [],
        [coverage('vfs'), coverage('attachment', 'unavailable')],
      ),
      evidence: [
        evidence('vfs', { reference: 'vfs-search' }),
        evidence('attachment'),
      ],
    },
    fileResponse([match], [coverage('vfs')]),
  ];
  for (const raw of responses) {
    const { host, token } = fixture('ixo_files_find', () => raw);
    const result = await host.invoke(token, 'ixo_files_find', {
      query: 'photo',
    });
    assert.equal(result.reason, 'invalid_source_response');
    assert.equal('value' in result, false);
  }
});

test('complete file coverage without source references is invalid and coverage receipts need current resource access', async () => {
  for (const invalidCoverage of [
    [
      { source: 'vfs', state: 'complete' },
      { source: 'attachment', state: 'complete' },
    ],
    [null],
    [{ ...coverage('attachment'), state: 'unavailable' }],
  ]) {
    const malformed = fixture('ixo_files_find', () =>
      response({ matches: [], coverage: invalidCoverage }, 'vfs'),
    );
    assert.equal(
      (
        await malformed.host.invoke(malformed.token, 'ixo_files_find', {
          query: 'report',
        })
      ).reason,
      'invalid_source_response',
    );
  }
  const { host, token } = fixture('ixo_files_find', () => fileResponse(), {
    resourceAccess: async (_, receipt) => receipt.source !== 'attachment',
  });
  const result = await host.invoke(token, 'ixo_files_find', {
    query: 'report',
  });
  assert.equal(result.reason, 'resource_denied');
  assert.equal('value' in result, false);
});

test('unindexed PDF remains a file match with exact source and revision', async () => {
  const match = {
    source: 'vfs',
    reference: 'record-1',
    revision: 'rev-1',
    name: 'budget.pdf',
    uploadedAt: '2026-10-23T10:00:00Z',
    indexedText: false,
  };
  const { host, token } = fixture('ixo_files_find', () =>
    fileResponse(
      [match],
      [coverage('vfs', 'not_indexed'), coverage('attachment', 'unavailable')],
    ),
  );
  const result = await host.invoke(token, 'ixo_files_find', {
    query: 'budget',
  });
  assert.deepEqual(result.value.matches, [match]);
  assert.equal(result.value.absenceConfirmed, false);
});

test('file matches require a source upload timestamp before disclosure', async () => {
  for (const uploadedAt of [undefined, '', 'not-a-date', 1792749600]) {
    const match = {
      source: 'vfs',
      reference: 'record-1',
      revision: 'rev-1',
      name: 'budget.pdf',
      indexedText: false,
      ...(uploadedAt === undefined ? {} : { uploadedAt }),
    };
    const { host, token } = fixture('ixo_files_find', () =>
      fileResponse([match]),
    );
    const result = await host.invoke(token, 'ixo_files_find', {
      query: 'budget',
    });
    assert.equal(result.reason, 'invalid_source_response');
    assert.equal('value' in result, false);
  }
});

test('yesterday uses the host timezone and retains the calendar-day boundary for the adapter', async () => {
  let input;
  const { host, token } = fixture(
    'ixo_files_find',
    (request) => {
      input = request.input;
      return fileResponse();
    },
    {
      now: () => Date.parse('2026-10-23T18:00:00Z'),
      readGrants: async () => [grant('ixo_files_find')],
    },
  );
  await host.invoke(token, 'ixo_files_find', {
    query: 'upload',
    when: 'yesterday',
  });
  assert.deepEqual(input.when, {
    calendarDate: '2026-10-23',
    timezone: 'Asia/Singapore',
  });
});

test('resource authorization is required and rechecked after retrieval', async () => {
  const adapter = () =>
    response(
      {
        errorId: 'record-1',
        explanation: 'Retry later',
        permittedNextSteps: [],
      },
      'operation_error',
    );
  for (const [resourceAccess, reason] of [
    [undefined, 'resource_check_not_integrated'],
    [async () => false, 'resource_denied'],
    [
      async () => {
        throw new Error('secret');
      },
      'resource_check_failed',
    ],
  ]) {
    const { host, token } = fixture('ixo_error_explain', adapter, {
      resourceAccess,
    });
    assert.equal(
      (await host.invoke(token, 'ixo_error_explain', { errorId: 'record-1' }))
        .reason,
      reason,
    );
  }
  let active = true;
  const { host, token } = fixture(
    'ixo_files_find',
    () => {
      active = false;
      return fileResponse();
    },
    { resourceAccess: async () => active },
  );
  assert.equal(
    (await host.invoke(token, 'ixo_files_find', { query: 'removed file' }))
      .reason,
    'resource_denied',
  );
});

test('supplied error text uses catalog guidance without requiring owned-record access', async () => {
  let received;
  const { host } = fixture(
    'ixo_error_explain',
    (request) => {
      received = request.input;
      return response(
        {
          errorText: request.input.errorText,
          explanation: 'Check the fee balance before retrying.',
          permittedNextSteps: ['Review the fee estimate.'],
        },
        'error_catalog',
        { scope: { ...facts, visibility: 'shared' } },
      );
    },
    { resourceAccess: undefined },
  );
  const token = host.bindContext({ ...facts, visibility: 'shared' });
  assert.deepEqual((await host.discover(token)).tools, ['ixo_error_explain']);
  const result = await host.invoke(token, 'ixo_error_explain', {
    errorText: 'insufficient fees',
  });
  assert.equal(result.status, 'available');
  assert.deepEqual(received, { errorText: 'insufficient fees' });
  assert.deepEqual(result.value, {
    errorText: 'insufficient fees',
    explanation: 'Check the fee balance before retrying.',
    permittedNextSteps: ['Review the fee estimate.'],
  });
  assert.equal(result.evidence[0].source, 'error_catalog');
  assert.equal(
    (await host.invoke(token, 'ixo_error_explain', { errorId: 'record-1' }))
      .reason,
    'disclosure_denied',
  );
  const privateToken = host.bindContext(facts);
  assert.equal(
    (
      await host.invoke(privateToken, 'ixo_error_explain', {
        errorId: 'record-1',
      })
    ).reason,
    'resource_check_not_integrated',
  );
  const ungranted = fixture(
    'ixo_error_explain',
    () => {
      throw new Error('must not run');
    },
    { readGrants: async () => [], resourceAccess: undefined },
  );
  assert.equal(
    (
      await ungranted.host.invoke(ungranted.token, 'ixo_error_explain', {
        errorText: 'insufficient fees',
      })
    ).reason,
    'grant_missing',
  );
});

test('error explanation requires exactly one bounded text or record selector before dispatch', async () => {
  let calls = 0;
  const { host, token } = fixture('ixo_error_explain', () => {
    calls++;
  });
  for (const args of [
    {},
    { errorId: 'record-1', errorText: 'insufficient fees' },
    { errorText: '' },
    { errorText: 'x'.repeat(4001) },
    { errorText: 32 },
    { errorText: 'oops', operationId: 'record-1' },
  ]) {
    assert.equal(
      (await host.invoke(token, 'ixo_error_explain', args)).reason,
      'invalid_arguments',
    );
  }
  assert.equal(calls, 0);
});

test('error modes reject swapped evidence, response modes, and changed supplied text', async () => {
  for (const [args, value, source, reason] of [
    [
      { errorText: 'insufficient fees' },
      {
        errorText: 'insufficient fees',
        explanation: 'Check fee balance.',
        permittedNextSteps: [],
      },
      'operation_error',
      'invalid_evidence',
    ],
    [
      { errorId: 'record-1' },
      {
        errorId: 'record-1',
        explanation: 'Check fee balance.',
        permittedNextSteps: [],
      },
      'error_catalog',
      'invalid_evidence',
    ],
    [
      { errorText: 'insufficient fees' },
      {
        errorId: 'record-1',
        explanation: 'Check fee balance.',
        permittedNextSteps: [],
      },
      'operation_error',
      'invalid_source_response',
    ],
    [
      { errorText: 'insufficient fees' },
      {
        errorText: 'transaction completed',
        explanation: 'Check fee balance.',
        permittedNextSteps: [],
      },
      'error_catalog',
      'error_mismatch',
    ],
    [
      { errorText: 'insufficient fees' },
      {
        errorText: 'insufficient fees',
        errorId: 'record-1',
        explanation: 'Check fee balance.',
        permittedNextSteps: [],
      },
      'error_catalog',
      'invalid_source_response',
    ],
  ]) {
    const { host, token } = fixture('ixo_error_explain', () =>
      response(value, source),
    );
    const result = await host.invoke(token, 'ixo_error_explain', args);
    assert.equal(result.reason, reason);
    assert.equal('value' in result, false);
  }
});

test('owned error receipts keep exact ownership, evidence, and resource authorization requirements', async () => {
  const checked = [];
  const { host, token } = fixture(
    'ixo_error_explain',
    () =>
      response(
        {
          errorId: 'record-1',
          explanation: 'Check fee balance.',
          permittedNextSteps: [],
        },
        'operation_error',
      ),
    {
      resourceAccess: async (_, receipt) => {
        checked.push(receipt);
        return true;
      },
    },
  );
  assert.equal(
    (await host.invoke(token, 'ixo_error_explain', { errorId: 'record-1' }))
      .status,
    'available',
  );
  assert.equal(checked.length, 1);
  assert.equal(checked[0].reference, 'record-1');
  assert.equal(
    (
      await host.invoke(token, 'ixo_error_explain', {
        errorId: 'another-record',
      })
    ).reason,
    'scope_denied',
  );
  const uncited = fixture('ixo_error_explain', () =>
    response(
      {
        errorId: 'requested',
        explanation: 'Check fees.',
        permittedNextSteps: [],
      },
      'operation_error',
    ),
  );
  assert.equal(
    (
      await uncited.host.invoke(uncited.token, 'ixo_error_explain', {
        errorId: 'requested',
      })
    ).reason,
    'evidence_missing',
  );
});

test('guessed operation IDs cannot return another operation or uncited data', async () => {
  const { host, token } = fixture('ixo_operation_get', () =>
    response({ operationId: 'other', state: 'completed' }, 'operation'),
  );
  assert.equal(
    (await host.invoke(token, 'ixo_operation_get', { operationId: 'record-1' }))
      .reason,
    'scope_denied',
  );
  const missing = fixture('ixo_operation_get', () =>
    response({ operationId: 'requested', state: 'pending' }, 'operation'),
  );
  assert.equal(
    (
      await missing.host.invoke(missing.token, 'ixo_operation_get', {
        operationId: 'requested',
      })
    ).reason,
    'evidence_missing',
  );
});

test('quote requires reviewed host restriction in addition to current permission', async () => {
  const args = { asset: 'USDC', amount: '10.00', corridor: 'ZA-bank' };
  const adapter = () => quoteResponse();
  const blocked = fixture('ixo_offramp_quote', adapter);
  assert.deepEqual((await blocked.host.discover(blocked.token)).tools, []);
  assert.equal(
    (await blocked.host.invoke(blocked.token, 'ixo_offramp_quote', args))
      .reason,
    'restricted_adapter_required',
  );
  const allowed = fixture('ixo_offramp_quote', adapter, {
    reviewedQuoteAdapter: true,
  });
  assert.equal(
    (await allowed.host.invoke(allowed.token, 'ixo_offramp_quote', args)).value
      .quoteId,
    'q1',
  );
  assert.equal(
    (
      await allowed.host.invoke(allowed.token, 'ixo_offramp_quote', {
        ...args,
        confirmed: true,
      })
    ).reason,
    'invalid_arguments',
  );
});

test('expired quote is unavailable and provides no executable fallback', async () => {
  const { host, token } = fixture(
    'ixo_offramp_quote',
    () => quoteResponse({ amount: '10', expiresAt: '2026-10-24T11:59:00Z' }),
    { reviewedQuoteAdapter: true },
  );
  assert.deepEqual(
    await host.invoke(token, 'ixo_offramp_quote', {
      asset: 'USDC',
      amount: '10',
      corridor: 'ZA-bank',
    }),
    { status: 'unavailable', reason: 'quote_expired', retryable: true },
  );
});

test('quote binds the requested asset, positive amount, and corridor', async () => {
  const args = { asset: 'USDC', amount: '10.00', corridor: 'ZA-bank' };
  for (const mismatch of [
    { amount: '100.00' },
    { corridor: 'KE-bank' },
    { asset: 'BTC' },
    { denomination: 'BTC' },
  ]) {
    const { host, token } = fixture(
      'ixo_offramp_quote',
      () => quoteResponse(mismatch),
      { reviewedQuoteAdapter: true },
    );
    const result = await host.invoke(token, 'ixo_offramp_quote', args);
    assert.equal(result.status, 'unavailable');
    assert.equal('value' in result, false);
  }
  let calls = 0;
  const { host, token } = fixture(
    'ixo_offramp_quote',
    () => {
      calls++;
    },
    { reviewedQuoteAdapter: true },
  );
  for (const amount of ['0', '0.00', '-1', 'NaN', '1e4'])
    assert.equal(
      (await host.invoke(token, 'ixo_offramp_quote', { ...args, amount }))
        .reason,
      'invalid_arguments',
    );
  assert.equal(calls, 0);
});

test('corridor quotes disclose the sourced payout, rate, fee and expiry with quote-specific evidence', async () => {
  const { host, token } = fixture('ixo_offramp_quote', () => quoteResponse(), {
    reviewedQuoteAdapter: true,
  });
  const args = { asset: 'USDC', amount: '10.00', corridor: 'ZA-bank' };
  const result = await host.invoke(token, 'ixo_offramp_quote', args);
  assert.equal(result.status, 'available');
  assert.deepEqual(result.value, {
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
  });
  assert.equal(result.evidence[0].reference, 'q1');
  for (const extra of [
    { recipientRef: 'bank-1' },
    { bankAccount: '1234' },
    { confirmed: true },
  ]) {
    assert.equal(
      (await host.invoke(token, 'ixo_offramp_quote', { ...args, ...extra }))
        .reason,
      'invalid_arguments',
    );
  }
  assert.equal(
    (await host.invoke(token, 'ixo_offramp_quote', { ...args, amount: '10' }))
      .reason,
    'quote_mismatch',
  );
});

test('invalid or unbound quote payout fields never produce an available financial answer', async () => {
  const args = { asset: 'USDC', amount: '10.00', corridor: 'ZA-bank' };
  const invalid = [
    ...['payoutAmount', 'rate'].flatMap((field) =>
      ['0', '0.00', '-1', '1e4', 10, ''].map((value) => ({ [field]: value })),
    ),
    ...['', 'zar', 'RAND', 1].map((payoutCurrency) => ({ payoutCurrency })),
    { fee: '-0.1' },
    { quoteScope: 'recipient' },
    { recipientRef: 'bank-1' },
    { expiresAt: 'unknown' },
  ];
  for (const values of invalid) {
    const { host, token } = fixture(
      'ixo_offramp_quote',
      () => quoteResponse(values),
      { reviewedQuoteAdapter: true },
    );
    const result = await host.invoke(token, 'ixo_offramp_quote', args);
    assert.equal(result.status, 'unavailable');
    assert.equal('value' in result, false);
  }
  for (const field of ['payoutAmount', 'payoutCurrency', 'rate']) {
    const raw = quoteResponse();
    delete raw.value[field];
    const { host, token } = fixture('ixo_offramp_quote', () => raw, {
      reviewedQuoteAdapter: true,
    });
    assert.equal(
      (await host.invoke(token, 'ixo_offramp_quote', args)).reason,
      'invalid_source_response',
    );
  }
  const uncited = fixture(
    'ixo_offramp_quote',
    () => response(quote(), 'offramp'),
    { reviewedQuoteAdapter: true },
  );
  assert.equal(
    (await uncited.host.invoke(uncited.token, 'ixo_offramp_quote', args))
      .reason,
    'evidence_missing',
  );
});
