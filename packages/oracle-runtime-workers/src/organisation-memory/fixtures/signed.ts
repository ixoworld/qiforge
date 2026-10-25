import {
  createDelegation,
  createInvocation,
  createIxoDIDResolver,
  serializeDelegation,
  serializeInvocation,
  signerFromMnemonic,
  type Capability,
} from '@ixo/ucan';
import fixture from './v1.json';
import { boundFacts, parseImportBody, type Operation } from '../contract';

export const ORACLE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const USER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
export const USER_DID = 'did:ixo:ixo1ownerfixture';
export const ORACLE_DID = 'did:ixo:ixo1oraclefixture';

export async function signedFixture(
  options: {
    operation?: Operation;
    raw?: string;
    expiry?: number;
    grantExpiry?: number;
    capabilities?: Capability[];
    audience?: string;
    grantAudience?: string;
    facts?: Record<string, string | number>[];
  } = {},
) {
  const user = await signerFromMnemonic(USER_MNEMONIC);
  const oracle = await signerFromMnemonic(ORACLE_MNEMONIC);
  const signer = user.signer.withDID(USER_DID);
  const body = await parseImportBody(fixture.rawBody);
  const operation = options.operation ?? 'submit';
  const raw =
    options.raw ??
    (operation === 'submit' ? fixture.rawBody : fixture.rawStatusBody);
  const now = Math.floor(Date.now() / 1000);
  const grant = await serializeDelegation(
    await createDelegation({
      issuer: signer,
      audience: options.grantAudience ?? options.audience ?? ORACLE_DID,
      capabilities: options.capabilities ?? [
        { can: 'memory/*', with: 'ixo:memory' },
      ],
      expiration: options.grantExpiry ?? now + 300,
    }),
  );
  const token = await serializeInvocation(
    await createInvocation({
      issuer: signer,
      audience: options.audience ?? ORACLE_DID,
      capability: { can: '*', with: 'ixo:oracle' },
      proofs: [],
      expiration: options.expiry ?? now + 60,
      facts: options.facts ?? [
        await boundFacts(
          operation,
          raw,
          operation === 'submit'
            ? body
            : { ...body, requestDigest: fixture.requestDigest },
        ),
        { nonce: crypto.randomUUID() },
      ],
    }),
  );
  const didResolver = createIxoDIDResolver({
    indexerUrl: 'https://blocksync.test/graphql',
    fetch: async (_url, init) => {
      const query: unknown = JSON.parse(String(init?.body));
      const requested =
        typeof query === 'object' &&
        query &&
        'variables' in query &&
        typeof query.variables === 'object' &&
        query.variables &&
        'id' in query.variables
          ? query.variables.id
          : undefined;
      const key =
        requested === USER_DID
          ? user.did
          : requested === ORACLE_DID
            ? oracle.did
            : null;
      return Response.json({
        data: {
          iids: {
            nodes: key
              ? [
                  {
                    id: requested,
                    verificationMethod: [
                      {
                        id: `${requested}#key-1`,
                        type: 'Ed25519VerificationKey2020',
                        controller: requested,
                        publicKeyMultibase: key.slice('did:key:'.length),
                      },
                    ],
                  },
                ]
              : [],
          },
        },
      });
    },
  });
  return {
    body,
    raw,
    grant,
    token,
    config: { oracleDid: ORACLE_DID, didResolver },
    headers: new Headers({
      authorization: `Bearer ${token}`,
      'x-auth-type': 'ucan',
      'x-ucan-delegation': grant,
    }),
  };
}
