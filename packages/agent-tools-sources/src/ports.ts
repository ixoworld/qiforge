import type { HostFacts } from '@ixo/agent-tools';

export interface SourceAuthority {
  subscriptions(context: HostFacts): Promise<string | null>;
  vfs(context: HostFacts, action: 'list' | 'read'): Promise<string | null>;
  memory(context: HostFacts): Promise<string | null>;
  yellowcard(
    context: HostFacts,
    action: 'read' | 'quote',
  ): Promise<string | null>;
}

export type AttachmentReceipt = Readonly<{
  reference: string;
  revision: string;
  name: string;
  receivedAt: string;
  userDid: string;
  sessionId: string;
  messageId: string;
}>;
export interface SessionAttachments {
  inventory(context: HostFacts): Promise<
    Readonly<{
      receipts: readonly AttachmentReceipt[];
      complete: boolean;
      reference: string;
      revision: string;
      observedAt: string;
    }>
  >;
  current(
    context: HostFacts,
    reference: string,
    revision: string,
  ): Promise<boolean>;
}
export type SourceConfig = Readonly<{
  network: 'mainnet' | 'testnet' | 'devnet';
  origins: Readonly<{
    subscriptions: string;
    vfs: string;
    memory: string;
    yellowcard: string;
  }>;
  authority: SourceAuthority;
  attachments: SessionAttachments;
  oracleKnowledge?: 'public' | 'private';
  fetch?: typeof fetch;
}>;
