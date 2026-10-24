const context = {
  userDid: 'did:ixo:alice',
  oracleDid: 'did:ixo:companion',
  network: 'devnet',
};
const revision = `sha256:${'a'.repeat(64)}`;
const scope = { userDid: context.userDid, network: context.network };
export async function protocolResponse(input, init) {
  const now = new Date().toISOString();
  const url = new globalThis.URL(input);
  if (url.pathname === '/.well-known/did.json')
    return globalThis.Response.json({
      id: `did:web:${url.host.replaceAll(':', '%3A')}`,
    });
  if (!new globalThis.Headers(init?.headers).get('Authorization'))
    return new globalThis.Response('', { status: 401 });
  const body = init?.body ? JSON.parse(init.body) : undefined;
  if (url.pathname === '/api/v1/subscriptions/account')
    return globalThis.Response.json({
      representation: 1,
      scope: { ...scope, userAddress: 'alice' },
      address: 'alice',
      addressType: 'ixo_account',
      binding: 'verified_root_did',
      observedAt: now,
    });
  if (url.pathname === '/api/v1/subscriptions')
    return globalThis.Response.json({
      representation: 2,
      scope: { ...scope, userAddress: 'alice' },
      balance: {
        availability: 'available',
        ledger: {
          kind: 'subscription_credits',
          denom: 'upay',
          baseUnitsPerCredit: '1000',
          presentationUnit: 'credits',
        },
        account: { role: 'subscription_admin', address: 'admin' },
        amountBaseUnits: '1234',
        credits: '1.234',
        observedAt: now,
        source: { kind: 'cosmos_bank', chainFreshness: 'unknown' },
      },
    });
  if (url.pathname === '/api/fs/observations')
    return globalThis.Response.json({
      scope: {
        userDid: context.userDid,
        namespace: 'user:alice',
        path: '/',
      },
      observedAt: now,
      revisionKind: 'metadata-observation',
      coverage: 'complete',
      searchCoverage: 'unverified',
      snapshotRevision: 'b'.repeat(64),
      files: [],
    });
  if (url.pathname === '/api/fs/observations/check')
    return globalThis.Response.json({
      scope: {
        userDid: context.userDid,
        namespace: 'user:alice',
        path: '/',
      },
      observedAt: now,
      current: true,
      files: [],
    });
  if (url.pathname === '/agent/search')
    return globalThis.Response.json({
      representation: 1,
      scope: {
        userDid: context.userDid,
        oracleDid: context.oracleDid,
        knowledgeScope: body.scope,
      },
      observedAt: now,
      facts: [],
      observation: {
        reference: 'memory:observation:a',
        revision,
        query: body.query,
        limit: 10,
        coverage: 'bounded',
        empty: true,
      },
    });
  if (url.pathname === '/agent/references/check')
    return globalThis.Response.json({
      representation: 1,
      scope: {
        userDid: context.userDid,
        oracleDid: context.oracleDid,
        knowledgeScope: body.scope,
      },
      observedAt: now,
      valid: true,
    });
  const observed = (value, metadata = {}) =>
    globalThis.Response.json({
      representation: 1,
      scope,
      observedAt: now,
      revision,
      value,
      metadata,
    });
  if (url.pathname === '/agent/options')
    return observed(
      { eligibility: 'unknown', corridors: [] },
      {
        country: 'ZM',
        source: 'allowlist',
        eligibilityScope: 'corridor',
        kycEligibility: 'unknown',
      },
    );
  if (url.pathname === '/agent/quote')
    return observed(
      {
        ...body,
        quoteId: 'quote-a',
        quoteScope: 'corridor',
        payoutAmount: '260.00',
        payoutCurrency: 'ZMW',
        rate: '26',
        fee: '0.1',
        denomination: 'USDC',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
      { kind: 'estimate', settlementLocked: false, cryptoNetwork: 'BASE' },
    );
  if (url.pathname === '/agent/operations/operation-a')
    return observed({ operationId: 'operation-a', state: 'pending' });
  if (url.pathname === '/agent/errors/error-a')
    return observed({
      errorId: 'error-a',
      explanation: 'Review the source operation.',
      permittedNextSteps: ['Open the Portal.'],
    });
  throw new Error(`Unexpected endpoint ${url}`);
}
