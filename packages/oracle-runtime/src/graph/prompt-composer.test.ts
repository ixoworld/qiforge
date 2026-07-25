import { describe, expect, it } from 'vitest';
import type {
  CommunityResult,
  EntityResult,
  EpisodeResult,
  FactResult,
  SearchEnhancedResponse,
} from '@ixo/common';
import type { OracleIdentity } from '../plugin-api/types.js';
import { composePrompt, type ComposePromptInput } from './prompt-composer.js';

const IDENTITY: OracleIdentity = {
  name: 'Qi',
  org: 'IXO',
  description: 'A test oracle',
  entityDid: 'did:ixo:entity:test',
};

function entity(
  name: string,
  summary: string,
  labels: string[] = ['Entity'],
): EntityResult {
  return {
    uuid: `e:${name}:${summary.length}`,
    name,
    summary,
    labels,
    group_id: 'g',
    created_at: '2026-01-01T00:00:00Z',
  };
}

function fact(text: string): FactResult {
  return {
    uuid: `f:${text}`,
    fact: text,
    source_node_uuid: 's',
    target_node_uuid: 't',
    created_at: '2026-01-01T00:00:00Z',
    valid_at: null,
    invalid_at: null,
  };
}

function episode(content: string): EpisodeResult {
  return {
    uuid: `ep:${content}`,
    name: 'ep',
    content,
    created_at: '2026-06-01T00:00:00Z',
    group_id: 'g',
  };
}

function community(name: string, summary: string): CommunityResult {
  return { uuid: `c:${name}`, name, summary, created_at: null };
}

function section(
  partial: Partial<SearchEnhancedResponse>,
): SearchEnhancedResponse {
  return {
    strategy_used: 'balanced',
    query: '',
    total_results: { facts: 0, entities: 0, episodes: 0, communities: 0 },
    facts: [],
    entities: [],
    episodes: [],
    communities: [],
    ...partial,
  };
}

function baseInput(overrides: Partial<ComposePromptInput>): ComposePromptInput {
  return {
    identity: IDENTITY,
    capabilityBlock: '',
    customInstructions: '',
    operationalMode: 'General conversation mode',
    commerceOverlay: '',
    editorSection: '',
    composioContext: '',
    slackFormattingConstraints: '',
    userSecretsContext: '',
    userPreferencesContext: '',
    userContext: undefined,
    timeContext: 'now',
    currentEntityDid: '',
    ...overrides,
  };
}

/** Count non-overlapping occurrences of a substring. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('composePrompt — compact memory context', () => {
  // Same entity + same fact echoed across three buckets, plus a near-duplicate
  // fact that differs only in wording — the shape the memory engine returns.
  const userContext = {
    identity: section({
      entities: [entity('user', 'user asked to schedule UE5 builds')],
      facts: [fact('The user provides daily LinkedIn drafts.')],
    }),
    work: section({
      entities: [
        entity('user', 'user asked to schedule UE5 builds every two weeks'),
      ],
      facts: [
        fact('The user provides daily LinkedIn drafts.'),
        fact('the user wants to chart the key trends'),
      ],
    }),
    interests: section({
      entities: [entity('user', 'user asked to schedule UE5 builds')],
      facts: [
        fact('The user provides daily LinkedIn drafts.'),
        fact('the user asks to chart the key trends'),
      ],
    }),
  };

  it('dedups repeats but keeps near-duplicates and the richest summary', async () => {
    const prompt = await composePrompt(baseInput({ userContext }));

    // Exact-duplicate fact collapses to a single line.
    expect(count(prompt, 'The user provides daily LinkedIn drafts.')).toBe(1);
    // Entity deduped by name across buckets.
    expect(count(prompt, '**user**')).toBe(1);
    // Richest (longest) summary is the one kept.
    expect(prompt).toContain(
      'user asked to schedule UE5 builds every two weeks',
    );
    // Near-duplicate facts differ in wording, so BOTH survive — no unique
    // information is dropped.
    expect(prompt).toContain('wants to chart the key trends');
    expect(prompt).toContain('asks to chart the key trends');
  });

  it('keeps episodes and communities (deduped, not dropped by type)', async () => {
    const prompt = await composePrompt(
      baseInput({
        userContext: {
          recent: section({
            episodes: [
              episode('user ran a UE5 build on Tuesday'),
              episode('user ran a UE5 build on Tuesday'),
            ],
            communities: [community('UE5 workflow', 'builds and blueprints')],
          }),
        },
      }),
    );
    expect(prompt).toContain('user ran a UE5 build on Tuesday');
    expect(count(prompt, 'user ran a UE5 build on Tuesday')).toBe(1);
    expect(prompt).toContain('UE5 workflow');
  });

  it('budgets an oversized block with a recall footer', async () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      fact(`distinct durable fact number ${i} about the user's work`),
    );
    const prompt = await composePrompt(
      baseInput({
        userContext: { work: section({ facts: many }) },
      }),
    );
    expect(prompt).toContain('ask me to recall');
    // Early facts survive; the long tail is trimmed under the budget.
    expect(prompt).toContain('distinct durable fact number 0 ');
    expect(prompt).not.toContain('distinct durable fact number 399 ');
  });
});

describe('composePrompt — commerce overlay slot', () => {
  it('renders the overlay after the operational mode when provided', async () => {
    const prompt = await composePrompt(
      baseInput({
        commerceOverlay: '## Commerce mode\n\nYou are the front desk.',
      }),
    );

    expect(prompt).toContain('You are the front desk.');
    expect(prompt.indexOf('General conversation mode')).toBeLessThan(
      prompt.indexOf('You are the front desk.'),
    );
  });

  it('renders nothing for the empty overlay', async () => {
    const prompt = await composePrompt(baseInput({}));

    expect(prompt).not.toContain('Commerce mode');
  });
});

describe('composePrompt — capability discovery principle', () => {
  it('mandates discovery by default', async () => {
    const prompt = await composePrompt(baseInput({}));

    expect(prompt).toContain('**Search first, build second.**');
    expect(prompt).toContain('`search_skills`');
    expect(prompt).toContain('`load_capability({ names: [...] })`');
    // The bullets around it survive.
    expect(prompt).toContain('Being proactive does **not** mean');
  });

  it('drops it when the meta-tools are not bound', async () => {
    // Matrix support mode binds a closed tool surface. Ordering the model to
    // call `list_capabilities` / `load_capability` there describes a flow it
    // cannot run.
    const prompt = await composePrompt(
      baseInput({ capabilityDiscovery: false }),
    );

    expect(prompt).not.toContain('Search first, build second');
    expect(prompt).not.toContain('load_capability');
    expect(prompt).not.toContain('list_capabilities');
    expect(prompt).not.toContain('search_skills');
    // Only that bullet goes — the rest of the principles stand.
    expect(prompt).toContain('## Operating principles');
    expect(prompt).toContain('Being proactive does **not** mean');
    expect(prompt).toContain("Complete the user's request and stop.");
  });
});
