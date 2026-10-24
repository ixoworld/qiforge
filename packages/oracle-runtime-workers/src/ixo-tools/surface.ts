import type {
  Available,
  Discovery,
  HostFacts,
  Refusal,
  ToolName,
} from '@ixo/agent-tools';

export interface IxoToolsSurface {
  discover(): Promise<Discovery>;
  invoke(name: ToolName, args: unknown): Promise<Available<ToolName> | Refusal>;
}

export interface IxoToolsBinding {
  readonly scope: Pick<
    HostFacts,
    'userDid' | 'sessionId' | 'roomId' | 'timezone'
  >;
  readonly tools: IxoToolsSurface;
}
