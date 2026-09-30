import { describe, expect, it } from 'vitest';
import { PortableWorkDefinitionSchema } from './portable-work.js';

const definition = {
  version: 1,
  title: 'Research brief',
  intent: 'Produce a bounded research brief.',
  outcome: 'A reviewed brief exists.',
  definitionOfDone: ['Sources are verified'],
  rubricRefs: ['ixo:rubric:research-quality'],
  suggestedRoles: ['researcher'],
  suggestedCapabilities: ['web/search'],
  configurationDefaults: { includeSources: true, maxSources: 12 },
} as const;

describe('PortableWorkDefinitionSchema', () => {
  it('accepts definition-only reusable work', () => {
    expect(PortableWorkDefinitionSchema.parse(definition)).toEqual(definition);
  });

  it.each([
    ['principal', 'did:ixo:alice'],
    ['ucan', 'ucan-token'],
    ['credential', 'secret'],
    ['approval', 'approved'],
    ['claim', 'claim-1'],
    ['decision', 'decision-1'],
    ['receipt', 'receipt-1'],
    ['executionHandle', 'run-1'],
    ['settlementAuthority', 'did:ixo:treasury'],
  ])('rejects authority or execution state in %s', (key, value) => {
    expect(() =>
      PortableWorkDefinitionSchema.parse({ ...definition, [key]: value }),
    ).toThrow();
  });

  it('allows only inert scalar configuration defaults', () => {
    expect(() =>
      PortableWorkDefinitionSchema.parse({
        ...definition,
        configurationDefaults: { connector: { credentialRef: 'secret' } },
      }),
    ).toThrow();
  });
});
