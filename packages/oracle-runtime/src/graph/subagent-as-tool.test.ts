import { describe, expect, it } from 'vitest';
import { createSubagentAsTool, type AgentSpec } from './subagent-as-tool.js';

const baseSpec: AgentSpec = {
  name: 'memory',
  description: 'recalls facts',
  systemPrompt: 'you are the memory agent',
  userDid: 'did:ixo:user1',
  sessionId: 'session-1',
};

describe('createSubagentAsTool', () => {
  it('derives a `call_<name>_agent` tool name from a plain spec name', () => {
    const t = createSubagentAsTool(baseSpec);
    expect(t.name).toBe('call_memory_agent');
    expect(t.description).toBe('recalls facts');
  });

  it('does not double-suffix when the spec name already ends in `_agent`', () => {
    const t = createSubagentAsTool({ ...baseSpec, name: 'memory_agent' });
    expect(t.name).toBe('call_memory_agent');
  });

  it('lowercases and underscores spec names with mixed casing / spaces', () => {
    const t = createSubagentAsTool({ ...baseSpec, name: 'Domain Indexer' });
    expect(t.name).toBe('call_domain_indexer_agent');
  });

  it('returns a friendly error when no model is configured', async () => {
    const t = createSubagentAsTool(baseSpec);
    // The tool can be invoked through `.invoke({ task })` with a runtime
    // config; with no model we hit the early-return branch deterministically.
    const result = await t.invoke({ task: 'do the thing' });
    expect(String(result)).toContain('has no model configured');
  });
});
