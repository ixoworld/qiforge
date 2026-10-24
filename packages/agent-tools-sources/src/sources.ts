import type { Adapters, HostOptions } from '@ixo/agent-tools';
import type { SourceConfig } from './ports.js';
import { createSourceHttp } from './http.js';
import { subscriptionAdapters } from './subscriptions.js';
import { conceptAdapter } from './concepts.js';
import { fileAdapters } from './files.js';
import { memoryAdapters } from './memory.js';
import { yellowcardAdapters } from './yellowcard.js';

export function createIXOSourceAdapters(config: SourceConfig): Readonly<{
  adapters: Adapters;
  resourceAccess: NonNullable<HostOptions['resourceAccess']>;
}> {
  const http = createSourceHttp(config);
  const files = fileAdapters(http, config);
  const memory = memoryAdapters(http, config);
  const yellowcard = yellowcardAdapters(http);
  return Object.freeze({
    adapters: Object.freeze({
      ...subscriptionAdapters(http),
      ixo_concept_get: conceptAdapter(http),
      ...files.adapters,
      ...memory.adapters,
      ...yellowcard.adapters,
    }),
    resourceAccess: async (context, receipt) => {
      if (context.network !== config.network) return false;
      if (receipt.source === 'vfs' || receipt.source === 'attachment')
        return files.current(context, receipt);
      if (
        receipt.source === 'personal_memory' ||
        receipt.source === 'oracle_knowledge'
      )
        return memory.current(context, receipt);
      if (
        receipt.source === 'operation' ||
        receipt.source === 'operation_error'
      )
        return yellowcard.current(context, receipt);
      return false;
    },
  });
}
