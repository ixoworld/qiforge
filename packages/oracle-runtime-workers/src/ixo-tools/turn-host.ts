import {
  catalog,
  createAgentToolsHost,
  type HostFacts,
  type ToolName,
} from '@ixo/agent-tools';
import {
  createIXOSourceAdapters,
  type SourceConfig,
} from '@ixo/agent-tools-sources';
import type { IxoToolsConfig } from './config';
import {
  createIxoSourceAuthority,
  type CurrentSourceDelegation,
  type IxoSourceUcan,
} from './source-authority';
import type { IxoToolsBinding } from './surface';
import { lifetimeFetch, runIxoOperation } from './lifetime';

export type VerifiedIxoDelegation = CurrentSourceDelegation &
  Readonly<{
    expiration: number;
    revision: object;
  }>;
export type TurnIxoToolsInput = Readonly<{
  context: HostFacts & { network: SourceConfig['network'] };
  config: IxoToolsConfig;
  ucan: IxoSourceUcan;
  currentVerifiedDelegation: () => Promise<VerifiedIxoDelegation | null>;
  currentAudience: () => Promise<'private' | 'shared'>;
  attachments: SourceConfig['attachments'];
  fetch?: typeof fetch;
  lifetimeSignal?: AbortSignal;
}>;

export function createTurnIxoTools(input: TurnIxoToolsInput): IxoToolsBinding {
  const context = Object.freeze({ ...input.context });
  const enabled = new Set(input.config.enabledTools);
  function grantsTool(
    delegation: VerifiedIxoDelegation,
    name: ToolName,
  ): boolean {
    return (
      enabled.has(name) &&
      delegation.capabilities.some(
        (capability) =>
          capability.with === 'ixo:agent-tools' &&
          capability.can === `agent-tools/${name}` &&
          (!capability.nb || Object.keys(capability.nb).length === 0),
      )
    );
  }
  async function currentDelegation(signal: AbortSignal, tool?: ToolName) {
    signal.throwIfAborted();
    const before = await input.currentVerifiedDelegation();
    signal.throwIfAborted();
    if (!before || before.expiration <= Date.now() / 1000) return null;
    const audience = await input.currentAudience();
    signal.throwIfAborted();
    if (context.visibility === 'private' && audience !== 'private') return null;
    const after = await input.currentVerifiedDelegation();
    signal.throwIfAborted();
    if (
      !after ||
      after.raw !== before.raw ||
      after.revision !== before.revision ||
      after.expiration <= Date.now() / 1000
    )
      return null;
    return tool && !grantsTool(after, tool) ? null : after;
  }
  function bindHost(signal: AbortSignal, invokingTool?: ToolName) {
    const sources = createIXOSourceAdapters({
      network: context.network,
      origins: input.config.origins,
      oracleKnowledge: input.config.oracleKnowledge,
      attachments: input.attachments,
      authority: createIxoSourceAuthority({
        ucan: input.ucan,
        context,
        origins: input.config.origins,
        storeUrl: input.config.storeUrl,
        currentDelegation: () => currentDelegation(signal, invokingTool),
      }),
      fetch: lifetimeFetch(
        input.fetch ?? globalThis.fetch.bind(globalThis),
        signal,
      ),
    });
    const host = createAgentToolsHost({
      ...sources,
      readGrants: async () => {
        const delegation = await currentDelegation(signal);
        if (!delegation) return [];
        return catalog
          .filter(({ name }) => grantsTool(delegation, name))
          .map(({ name }) => ({
            ...context,
            tool: name,
            expiresAt: new Date(delegation.expiration * 1000).toISOString(),
          }));
      },
    });
    return { host, token: host.bindContext(context) };
  }
  return Object.freeze({
    scope: Object.freeze({
      userDid: context.userDid,
      sessionId: context.sessionId,
      roomId: context.roomId,
      timezone: context.timezone,
    }),
    tools: Object.freeze({
      discover: () =>
        runIxoOperation(input.lifetimeSignal, async (signal) => {
          const { host, token } = bindHost(signal);
          return host.discover(token);
        }),
      invoke: (name: ToolName, args: unknown) =>
        runIxoOperation(input.lifetimeSignal, async (signal) => {
          const { host, token } = bindHost(signal, name);
          return host.invoke(token, name, args);
        }),
    }),
  } satisfies IxoToolsBinding);
}
