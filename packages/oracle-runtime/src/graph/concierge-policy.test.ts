import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  RegisteredSubAgent,
  RegisteredTool,
} from '../registries/index.js';
import { applyConciergePolicy } from './concierge-policy.js';

function tool(pluginName: string, name: string): RegisteredTool {
  return {
    pluginName,
    tool: {
      name,
      description: `${name} test tool`,
      schema: z.object({}),
      handler: async () => 'ok',
    },
  };
}

function subAgent(pluginName: string, name: string): RegisteredSubAgent {
  return {
    pluginName,
    subAgent: {
      name,
      description: `${name} test sub-agent`,
      systemPrompt: 'test',
      tools: [],
    },
  };
}

describe('applyConciergePolicy', () => {
  it('keeps concierge tools and drops every other plugin tool', () => {
    const { tools } = applyConciergePolicy({
      allTools: [
        tool('concierge', 'get_oracle_info'),
        tool('concierge', 'escalate_to_support'),
        tool('sandbox', 'sandbox_run'),
        tool('composio', 'gmail_send'),
        tool('memory', 'memory-engine__add_episode'),
      ],
      allSubAgents: [],
    });

    expect(tools.map((t) => t.tool.name)).toEqual([
      'get_oracle_info',
      'escalate_to_support',
    ]);
  });

  it('keeps only the domain-indexer sub-agent', () => {
    const { subAgents } = applyConciergePolicy({
      allTools: [],
      allSubAgents: [
        subAgent('domain-indexer', 'domain_indexer_agent'),
        subAgent('editor', 'editor_agent'),
        subAgent('skills', 'skills_agent'),
      ],
    });

    expect(subAgents.map((s) => s.subAgent.name)).toEqual([
      'domain_indexer_agent',
    ]);
  });

  it('returns empty sets when nothing matches', () => {
    const { tools, subAgents } = applyConciergePolicy({
      allTools: [tool('sandbox', 'sandbox_run')],
      allSubAgents: [subAgent('editor', 'editor_agent')],
    });

    expect(tools).toEqual([]);
    expect(subAgents).toEqual([]);
  });
});
