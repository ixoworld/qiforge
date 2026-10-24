import type { HostFacts } from '@ixo/agent-tools';
import {
  createTurnIxoTools,
  type TurnIxoToolsInput,
} from '../ixo-tools/turn-host';
import type { IxoMcpAuthorization } from '../ixo-tools/mcp';

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function mcpContext(input: {
  authorization: IxoMcpAuthorization;
  oracleDid: string;
  network: TurnIxoToolsInput['context']['network'];
  visibility: HostFacts['visibility'];
}): Promise<TurnIxoToolsInput['context']> {
  const { principal, client } = input.authorization;
  const id = await digest([
    principal.iss,
    principal.aud,
    principal.sub,
    principal.client_id,
    principal.gid,
    principal.gver,
    input.oracleDid,
    input.network,
  ]);
  return Object.freeze({
    userDid: principal.sub,
    oracleDid: input.oracleDid,
    network: input.network,
    sessionId: `mcp:${id}`,
    roomId: `mcp:${id}`,
    timezone: client.timezone,
    visibility: input.visibility,
  });
}

export async function createMcpIxoTools(input: {
  authorization: IxoMcpAuthorization;
  oracleDid: string;
  network: TurnIxoToolsInput['context']['network'];
  config: TurnIxoToolsInput['config'];
  ucan: TurnIxoToolsInput['ucan'];
  currentVerifiedDelegation: TurnIxoToolsInput['currentVerifiedDelegation'];
  currentAudience: TurnIxoToolsInput['currentAudience'];
  fetch?: typeof fetch;
  lifetimeSignal?: AbortSignal;
}) {
  const context = await mcpContext({
    ...input,
    visibility: await input.currentAudience(),
  });
  const attachmentReference = `attachments:${context.sessionId}`;
  const attachmentRevision = `sha256:${await digest({
    context,
    receipts: [],
    complete: false,
  })}`;
  return createTurnIxoTools({
    context,
    lifetimeSignal: input.lifetimeSignal,
    config: input.config,
    ucan: input.ucan,
    currentAudience: input.currentAudience,
    currentVerifiedDelegation: async () => {
      if (!(await input.authorization.current())) return null;
      const native = await input.currentVerifiedDelegation();
      if (!native) return null;
      return {
        ...native,
        expiration: Math.min(
          native.expiration,
          input.authorization.principal.exp,
        ),
      };
    },
    attachments: {
      inventory: async () => ({
        receipts: [],
        complete: false,
        reference: attachmentReference,
        revision: attachmentRevision,
        observedAt: new Date().toISOString(),
      }),
      current: async (_context, reference, revision) =>
        reference === attachmentReference && revision === attachmentRevision,
    },
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
}
