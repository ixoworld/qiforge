import { z } from 'zod';
import type { Adapter, HostFacts, ResourceReceipt } from '@ixo/agent-tools';
import type { SourceConfig } from './ports.js';
import {
  available,
  evidence,
  guarded,
  instant,
  revision,
  SourceFailure,
  type SourceHttp,
} from './http.js';

const knowledge = z.enum(['personal', 'oracle_public', 'oracle_private']);
const scope = z.strictObject({
  userDid: z.string(),
  oracleDid: z.string(),
  knowledgeScope: knowledge,
});
const fact = z.strictObject({
  reference: z.string().min(1).max(4000),
  revision,
  text: z.string().min(1).max(4000),
  scope,
});
const searchResult = z.strictObject({
  representation: z.literal(1),
  scope,
  observedAt: instant,
  facts: z.array(fact).max(50),
  observation: z.strictObject({
    reference: z.string().startsWith('memory:observation:'),
    revision,
    query: z.string(),
    limit: z.number().int().min(1).max(50),
    coverage: z.literal('bounded'),
    empty: z.boolean(),
  }),
});
const checked = z.strictObject({
  representation: z.literal(1),
  scope,
  observedAt: instant,
  valid: z.boolean(),
});
function assertScope(
  value: z.output<typeof scope>,
  context: HostFacts,
  expected: z.output<typeof knowledge>,
): void {
  if (
    value.userDid !== context.userDid ||
    value.oracleDid !== context.oracleDid ||
    value.knowledgeScope !== expected ||
    (context.visibility === 'shared' && expected === 'oracle_private')
  )
    throw new SourceFailure('unauthorized');
}
export function memoryAdapters(http: SourceHttp, config: SourceConfig) {
  const oracleScope = (context: HostFacts) =>
    config.oracleKnowledge === 'private' && context.visibility === 'private'
      ? ('oracle_private' as const)
      : ('oracle_public' as const);
  async function search(
    context: HostFacts,
    query: string,
    knowledgeScope: z.output<typeof knowledge>,
  ) {
    const data = searchResult.parse(
      await http.request('memory', context, '/agent/search', {
        scope: knowledgeScope,
        query,
        limit: 10,
      }),
    );
    assertScope(data.scope, context, knowledgeScope);
    if (
      data.observation.query !== query.trim() ||
      data.observation.limit !== 10 ||
      data.observation.empty !== (data.facts.length === 0)
    )
      throw new SourceFailure('unavailable');
    for (const entry of data.facts)
      assertScope(entry.scope, context, knowledgeScope);
    const source =
      knowledgeScope === 'personal' ? 'personal_memory' : 'oracle_knowledge';
    const entries = data.facts.map(({ reference, revision, text }) => ({
      reference,
      revision,
      text,
    }));
    return available(
      context,
      knowledgeScope === 'personal'
        ? { facts: entries }
        : {
            knowledge: entries,
            visibility:
              knowledgeScope === 'oracle_private' ? 'private' : 'public',
          },
      [
        evidence(
          source,
          data.observation.reference,
          data.observation.revision,
          data.observedAt,
        ),
        ...entries.map((entry) =>
          evidence(source, entry.reference, entry.revision, data.observedAt),
        ),
      ],
    );
  }
  const ixo_memory_personal_search: Adapter<'ixo_memory_personal_search'> = ({
    context,
    input,
  }) => guarded(() => search(context, input.query, 'personal'));
  const ixo_memory_oracle_search: Adapter<'ixo_memory_oracle_search'> = ({
    context,
    input,
  }) => guarded(() => search(context, input.query, oracleScope(context)));
  async function current(
    context: HostFacts,
    receipt: ResourceReceipt,
  ): Promise<boolean> {
    const expected =
      receipt.source === 'personal_memory' ? 'personal' : oracleScope(context);
    const data = checked.parse(
      await http.request('memory', context, '/agent/references/check', {
        scope: expected,
        references: [
          { reference: receipt.reference, revision: receipt.revision },
        ],
      }),
    );
    assertScope(data.scope, context, expected);
    return data.valid;
  }
  return {
    adapters: { ixo_memory_personal_search, ixo_memory_oracle_search },
    current,
  };
}
