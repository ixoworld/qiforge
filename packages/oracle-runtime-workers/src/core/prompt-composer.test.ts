import { describe, expect, it } from 'vitest';
import type { OracleIdentity } from '../plugin-api/types';
import { renderTier1 } from './manifest';
import {
  composePrompt,
  formatTimeContext,
  formatUserPreferences,
  type ComposePromptInput,
  type MemoryContextSection,
} from './prompt-composer';
import { renderTemplate } from './template';

const IDENTITY: OracleIdentity = {
  name: 'Qi',
  org: 'IXO',
  description: 'A test oracle',
  entityDid: 'did:ixo:entity:test',
};

function baseInput(
  overrides: Partial<ComposePromptInput> = {},
): ComposePromptInput {
  return {
    identity: IDENTITY,
    capabilityBlock: '',
    customInstructions: '',
    operationalMode: 'General conversation mode',
    userPreferencesContext: '',
    userContext: undefined,
    timeContext: 'now',
    currentEntityDid: '',
    ...overrides,
  };
}

function section(partial: MemoryContextSection): MemoryContextSection {
  return { entities: [], facts: [], episodes: [], communities: [], ...partial };
}

/** Count non-overlapping occurrences of a substring. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('template renderer', () => {
  it('handles interpolation, sections (standalone lines) and inverted sections like Mustache', () => {
    const tpl =
      'A {{x}} {{{y}}}\n{{#s}}\nyes\n{{/s}}\n{{^s}}\nno\n{{/s}}\n{{! c }}\nZ';
    expect(renderTemplate(tpl, { x: '1', y: '<b>', s: 'on' })).toBe(
      'A 1 <b>\nyes\nZ',
    );
    expect(renderTemplate(tpl, { x: '1', y: '<b>', s: '' })).toBe(
      'A 1 <b>\nno\nZ',
    );
    // Inline section tags are not standalone — their line survives.
    expect(renderTemplate('[{{#s}}x{{/s}}]', { s: true })).toBe('[x]');
    expect(() => renderTemplate('{{#a}}', {})).toThrow(/never closed/);
  });
});

describe('composePrompt', () => {
  it('matches the reference rendering for a fully-populated prompt', async () => {
    const tier1 = renderTier1({
      manifests: [
        {
          pluginName: 'skills',
          manifest: {
            title: 'Skills',
            summary: 'Discover IXO skill capsules.',
            whenToUse: ['User asks what skills exist.'],
            whenNotToUse: ['Executing a skill.'],
            examples: [
              {
                user: 'Find an invoice skill',
                tool: 'search_skills',
                args: { q: 'invoice' },
              },
            ],
            visibility: 'always',
          },
        },
      ],
    });
    const prompt = await composePrompt(
      baseInput({
        identity: {
          ...IDENTITY,
          prompt: {
            capabilities: 'I help with weather and skills.',
            communicationStyle: 'Be warm and brief.',
            customInstructions: 'Always greet the user in French.',
          },
        },
        capabilityBlock: tier1.block,
        customInstructions: 'Always greet the user in French.',
        userPreferencesContext: formatUserPreferences({
          agentName: 'Q',
          language: 'fr',
        }),
        oracleNameOverride: 'Q',
        userContext: {
          work: section({
            entities: [
              {
                name: 'user',
                labels: ['Entity', 'Person'],
                summary: 'schedules UE5 builds',
              },
            ],
            facts: [{ fact: 'The user provides daily LinkedIn drafts.' }],
          }),
        },
        timeContext: formatTimeContext('Europe/Berlin', '2026-08-25T10:00:00Z'),
        currentEntityDid: 'did:ixo:entity:current',
        degradedServicesBlock: 'Memory is offline.',
      }),
    );
    expect(prompt).toMatchSnapshot();
  });

  it('omits every optional section when nothing feeds it', async () => {
    const prompt = await composePrompt(baseInput());
    expect(
      prompt.startsWith(
        'You are Qi, an AI agent operated by IXO. A test oracle.',
      ),
    ).toBe(true);
    expect(prompt).toContain('## Operating principles');
    expect(prompt).toContain('**Search first, build second.**');
    expect(prompt).not.toContain('## Custom Instructions');
    expect(prompt).not.toContain('## What you know about the user');
    expect(prompt).not.toContain('**Current entity:**');
    expect(prompt).not.toContain('## User preferences');
    expect(prompt).not.toContain('## Degraded services');
    expect(prompt).not.toContain('{{');
    expect(
      prompt
        .trimEnd()
        .endsWith('## Operational mode\n\nGeneral conversation mode'),
    ).toBe(true);
  });

  it('drops the discovery mandate when the meta-tools are not bound', async () => {
    const prompt = await composePrompt(
      baseInput({ capabilityDiscovery: false }),
    );
    expect(prompt).not.toContain('Search first, build second');
    expect(prompt).not.toContain('load_capability');
    expect(prompt).toContain('Being proactive does **not** mean');
  });

  it('dedups memory context across buckets and keeps the richest summary', async () => {
    const prompt = await composePrompt(
      baseInput({
        userContext: {
          identity: section({
            entities: [
              { name: 'user', summary: 'user asked to schedule UE5 builds' },
            ],
            facts: [{ fact: 'The user provides daily LinkedIn drafts.' }],
          }),
          work: section({
            entities: [
              {
                name: 'user',
                summary: 'user asked to schedule UE5 builds every two weeks',
              },
            ],
            facts: [
              { fact: 'The user provides daily LinkedIn drafts.' },
              { fact: 'the user wants to chart the key trends' },
            ],
          }),
        },
      }),
    );
    expect(count(prompt, 'The user provides daily LinkedIn drafts.')).toBe(1);
    expect(count(prompt, '**user**')).toBe(1);
    expect(prompt).toContain(
      'user asked to schedule UE5 builds every two weeks',
    );
    expect(prompt).toContain('wants to chart the key trends');
  });
});
