import {
  createUCANValidator,
  createLocalDIDResolver,
  defineCapability,
  parseDelegation,
  signerFromMnemonic,
} from '../../../ucan/src/index';
const userMnemonic =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const oracleMnemonic =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const serverMnemonic = 'test only subscriptions service seed';
const did = 'did:web:subscriptions.ixo.test';
let validatorPromise;
const read = defineCapability({ can: 'subscriptions/read', protocol: 'ixo:' });
async function validator() {
  if (!validatorPromise)
    validatorPromise = (async () => {
      const resolver = createLocalDIDResolver();
      for (const [name, mnemonic] of [
        ['did:ixo:alice', userMnemonic],
        ['did:ixo:companion', oracleMnemonic],
        [did, serverMnemonic],
      ]) {
        const identity = await signerFromMnemonic(mnemonic);
        resolver.register(name, identity.did.slice('did:key:'.length));
      }
      return createUCANValidator({
        serverDid: did,
        rootIssuers: ['did:ixo:alice'],
        didResolver: resolver,
      });
    })();
  return validatorPromise;
}
const observations = [];
export default {
  async fetch(request) {
    const url = new globalThis.URL(request.url);
    if (url.pathname === '/__observations')
      return globalThis.Response.json(observations);
    if (url.pathname === '/.well-known/did.json')
      return globalThis.Response.json({ id: did });
    const token = request.headers
      .get('authorization')
      ?.match(/^Bearer (.+)$/)?.[1];
    if (!token || request.headers.get('x-auth-type') !== 'ucan')
      return new globalThis.Response(null, { status: 401 });
    const validated = await (
      await validator()
    ).validate(token, read, 'ixo:subscriptions');
    if (!validated.ok)
      return globalThis.Response.json(
        { error: validated.error },
        { status: 403 },
      );
    const invocation = await parseDelegation(token);
    observations.push({
      audience: invocation.audience.did(),
      issuer: invocation.issuer.did(),
      capabilities: invocation.capabilities,
      expiration: invocation.expiration,
      observedAt: Math.floor(Date.now() / 1000),
      room: request.headers.get('x-room-id'),
      tokenIsJwt: token.split('.').length === 3,
      proofChain: validated.proofChain,
    });
    const now = new Date().toISOString();
    const scope = {
      userDid: 'did:ixo:alice',
      userAddress: 'alice',
      network: 'devnet',
    };
    if (url.pathname === '/api/v1/subscriptions/account')
      return globalThis.Response.json({
        representation: 1,
        scope,
        address: 'alice',
        addressType: 'ixo_account',
        binding: 'verified_root_did',
        observedAt: now,
      });
    if (url.pathname === '/api/v1/subscriptions')
      return globalThis.Response.json({
        representation: 2,
        scope,
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
    return new globalThis.Response(null, { status: 404 });
  },
};
