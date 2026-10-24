import { parseDelegation } from '@ixo/ucan';
import { z } from 'zod';
import { validateDelegation, type AuthConfig } from '../shell/auth';
import type { VerifiedIxoDelegation } from '../ixo-tools/turn-host';

export class CurrentDelegationMap<T extends { raw: string }> extends Map<
  string,
  T
> {
  generation = Object.freeze({});
  override set(key: string, value: T): this {
    this.generation = Object.freeze({});
    return super.set(key, value);
  }
  override delete(key: string): boolean {
    this.generation = Object.freeze({});
    return super.delete(key);
  }
  override clear(): void {
    this.generation = Object.freeze({});
    super.clear();
  }
}

const capabilitySchema = z.object({
  can: z.string(),
  with: z.string(),
  nb: z.record(z.string(), z.unknown()).optional(),
});
const nodeSchema = z.object({
  capabilities: z.array(capabilitySchema),
  proofs: z.array(z.unknown()),
});
function nativeCaveatsSupported(node: unknown): boolean {
  const parsed = nodeSchema.safeParse(node);
  if (!parsed.success) return false;
  return (
    parsed.data.capabilities.every(
      (capability) =>
        !(
          capability.with === '*' ||
          capability.with === 'ixo:agent-tools' ||
          capability.can.startsWith('agent-tools/')
        ) ||
        !capability.nb ||
        Object.keys(capability.nb).length === 0,
    ) && parsed.data.proofs.every(nativeCaveatsSupported)
  );
}

export function createCurrentIxoDelegationReader(input: {
  userDid: string;
  auth: AuthConfig;
  delegations: CurrentDelegationMap<{ raw: string }>;
}): () => Promise<VerifiedIxoDelegation | null> {
  return async () => {
    const entry = input.delegations.get(input.userDid);
    const generation = input.delegations.generation;
    const raw = entry?.raw;
    if (!raw) return null;
    const current = () =>
      input.delegations.generation === generation &&
      input.delegations.get(input.userDid) === entry &&
      entry.raw === raw;
    const verdict = await validateDelegation(raw, input.auth);
    if (!current()) return null;
    if (!verdict.ok) {
      if (verdict.error.startsWith('[EXPIRED]')) return null;
      throw new Error('IXO delegation verification unavailable');
    }
    if (
      verdict.userDid !== input.userDid ||
      !Number.isFinite(verdict.expiration) ||
      verdict.expiration <= Date.now() / 1000
    )
      return null;
    const delegation = await parseDelegation(raw);
    if (!current() || verdict.expiration <= Date.now() / 1000) return null;
    if (
      delegation.issuer.did() !== input.userDid ||
      delegation.audience.did() !== input.auth.oracleDid ||
      !nativeCaveatsSupported(delegation)
    )
      return null;
    return Object.freeze({
      raw,
      revision: generation,
      expiration: verdict.expiration,
      capabilities: Object.freeze(
        delegation.capabilities.map((capability) =>
          capabilitySchema.parse(capability),
        ),
      ),
    });
  };
}

export function isPrivateIxoAudience(input: {
  ownerMatrixId: string | undefined;
  oracleMatrixId: string;
  joined: readonly string[];
}): boolean {
  const { ownerMatrixId, oracleMatrixId, joined } = input;
  const members = new Set(joined);
  return Boolean(
    ownerMatrixId &&
    ownerMatrixId !== oracleMatrixId &&
    members.size === 2 &&
    members.has(ownerMatrixId) &&
    members.has(oracleMatrixId),
  );
}

const ownerDocumentSchema = z.object({
  data: z.object({
    iids: z.object({
      nodes: z.array(
        z.object({
          id: z.string(),
          service: z.array(
            z.object({
              type: z.string(),
              serviceEndpoint: z.string().optional(),
            }),
          ),
        }),
      ),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});

export function createCurrentIxoAudienceReader(input: {
  client: 'portal' | 'matrix' | 'channel' | 'mcp';
  sessionId: string;
  roomId: string;
  userDid: string;
  ownerMatrixId?: string;
  blocksyncUri: string;
  participants: (
    roomId: string,
  ) => Promise<{ oracleMatrixId: string; joined: string[] } | null>;
  fetch?: typeof fetch;
}): () => Promise<'private' | 'shared'> {
  return async () => {
    if (input.client === 'channel') return 'shared';
    if (
      input.client === 'portal' &&
      (!input.sessionId.startsWith('$') || input.sessionId.startsWith('$task-'))
    )
      return 'private';
    try {
      let ownerMatrixId =
        input.client === 'matrix' ? input.ownerMatrixId : undefined;
      if (input.client === 'portal' || input.client === 'mcp') {
        if (!input.userDid.startsWith('did:ixo:') || !input.blocksyncUri)
          return 'shared';
        const response = await (input.fetch ?? fetch)(input.blocksyncUri, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            query:
              'query NativeToolsOwner($id: String!) { iids(filter: { id: { equalTo: $id } }) { nodes { id service } } }',
            variables: { id: input.userDid },
          }),
          redirect: 'manual',
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) return 'shared';
        const result = ownerDocumentSchema.safeParse(await response.json());
        if (
          !result.success ||
          result.data.errors?.length ||
          result.data.data.iids.nodes.length !== 1
        )
          return 'shared';
        const document = result.data.data.iids.nodes[0];
        if (!document || document.id !== input.userDid) return 'shared';
        const services = document.service.filter(
          (service) => service.type === 'MatrixHomeServer',
        );
        const endpoint =
          services.length === 1 ? services[0]?.serviceEndpoint : undefined;
        if (!endpoint) return 'shared';
        const url = new URL(endpoint);
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== '/'
        )
          return 'shared';
        ownerMatrixId = `@${input.userDid.replaceAll(':', '-')}:${url.hostname}`;
      }
      if (!ownerMatrixId) return 'shared';
      const participants = await input.participants(input.roomId);
      return participants &&
        isPrivateIxoAudience({ ownerMatrixId, ...participants })
        ? 'private'
        : 'shared';
    } catch {
      return 'shared';
    }
  };
}
