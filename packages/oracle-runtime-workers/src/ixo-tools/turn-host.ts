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
  async function currentDelegation(tool?: ToolName) {
    const before = await input.currentVerifiedDelegation();
    if (!before || before.expiration <= Date.now() / 1000) return null;
    const audience = await input.currentAudience();
    if (context.visibility === 'private' && audience !== 'private') return null;
    const after = await input.currentVerifiedDelegation();
    if (
      !after ||
      after.raw !== before.raw ||
      after.revision !== before.revision ||
      after.expiration <= Date.now() / 1000
    )
      return null;
    return tool && !grantsTool(after, tool) ? null : after;
  }
  function bindHost(invokingTool?: ToolName) {
    let initialDelegation: VerifiedIxoDelegation | undefined;
    async function readDelegation() {
      const delegation = await currentDelegation(invokingTool);
      if (!delegation || !invokingTool) return delegation;
      // Every source and result check must use the invocation's original grant.
      initialDelegation ??= delegation;
      return delegation.raw === initialDelegation.raw &&
        delegation.revision === initialDelegation.revision
        ? delegation
        : null;
    }
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
        currentDelegation: readDelegation,
      }),
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
    const host = createAgentToolsHost({
      ...sources,
      readGrants: async () => {
        const delegation = await readDelegation();
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
  const discovery = bindHost();
  return Object.freeze({
    scope: Object.freeze({
      userDid: context.userDid,
      sessionId: context.sessionId,
      roomId: context.roomId,
      timezone: context.timezone,
    }),
    tools: Object.freeze({
      discover: () => discovery.host.discover(discovery.token),
      invoke: (name: ToolName, args: unknown) => {
        const { host, token } = bindHost(name);
        return host.invoke(token, name, args);
      },
    }),
  } satisfies IxoToolsBinding);
}
