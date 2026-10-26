import {
  createUCANValidator,
  defineCapability,
  parseDelegation,
  type DIDKeyResolver,
} from '@ixo/ucan';
import {
  ImportError,
  boundFacts,
  type ImportBody,
  type StatusBody,
  type Operation,
} from './contract';

const OracleAuth = defineCapability({ can: '*', protocol: 'ixo:' });
export interface ImportAuthConfig {
  oracleDid: string;
  didResolver: DIDKeyResolver;
}

export async function authenticateImport(
  headers: Headers,
  raw: string,
  body: ImportBody | StatusBody,
  operation: Operation,
  config: ImportAuthConfig,
): Promise<string | undefined> {
  const token = headers
    .get('authorization')
    ?.match(/^Bearer ([A-Za-z0-9+/=_-]+)$/i)?.[1];
  if (
    !token ||
    token.length > 32_000 ||
    headers.get('x-auth-type')?.toLowerCase() !== 'ucan'
  )
    throw new ImportError(401, 'invocation_required');
  const validator = await createUCANValidator({
    serverDid: config.oracleDid,
    rootIssuers: ['*'],
    didResolver: config.didResolver,
    requireExpiration: true,
    invocationStore: {
      has: async () => false,
      add: async () => undefined,
      addIfAbsent: async () => true,
    },
  });
  const result = await validator.validate(token, OracleAuth, 'ixo:oracle');
  const now = Math.floor(Date.now() / 1000);
  if (
    !result.ok ||
    result.invoker !== body.userDid ||
    !result.expiration ||
    !Number.isFinite(result.expiration) ||
    result.expiration <= now ||
    result.expiration > now + 90
  )
    throw new ImportError(401, 'invalid_invocation');
  const invocation = await parseDelegation(token);
  if (
    invocation.proofs.length !== 0 ||
    invocation.capabilities.length !== 1 ||
    invocation.capabilities[0]?.can !== '*' ||
    invocation.capabilities[0]?.with !== 'ixo:oracle'
  )
    throw new ImportError(401, 'direct_identity_invocation_required');
  const expected = await boundFacts(operation, raw, body);
  const facts = result.facts?.filter((f) => f.kind === expected.kind);
  const fact = facts?.[0];
  // The signer may add its separate nonce fact, or a nonce on this fact.
  if (
    facts?.length !== 1 ||
    !fact ||
    Object.entries(expected).some(([key, value]) => fact[key] !== value) ||
    Object.keys(fact).some((key) => !(key in expected) && key !== 'nonce')
  )
    throw new ImportError(403, 'invocation_binding_mismatch');
  if (operation === 'status') return undefined;
  const rawGrant = headers.get('x-ucan-delegation');
  if (!rawGrant || rawGrant.length > 32_000)
    throw new ImportError(401, 'memory_grant_required');
  const grantResult = await validator.validateDelegation(rawGrant);
  if (!grantResult.ok || grantResult.invoker !== body.userDid)
    throw new ImportError(401, 'invalid_memory_grant');
  const grant = await parseDelegation(rawGrant);
  const cap = grant.capabilities[0];
  if (
    grant.issuer.did() !== body.userDid ||
    grant.audience.did() !== config.oracleDid ||
    grant.proofs.length !== 0 ||
    grant.capabilities.length !== 1 ||
    cap?.can !== 'memory/*' ||
    cap.with !== 'ixo:memory' ||
    (cap.nb && Object.keys(cap.nb).length !== 0) ||
    !grant.expiration ||
    !Number.isFinite(grant.expiration) ||
    grant.expiration <= now ||
    grant.expiration > now + 300
  )
    throw new ImportError(403, 'memory_grant_scope_mismatch');
  return rawGrant;
}
