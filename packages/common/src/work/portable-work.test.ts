import { describe, expect, it } from 'vitest';
import {
  PORTABLE_WORK_RESERVED_CONFIGURATION_KEYS,
  PortableWorkDefinitionSchema,
} from './portable-work.js';

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

  it('accepts the minimal definition', () => {
    const minimal = { version: 1, title: 'T', intent: 'Do it.' };
    expect(PortableWorkDefinitionSchema.parse(minimal)).toEqual(minimal);
  });

  it.each([
    'definitionOfDone',
    'rubricRefs',
    'suggestedRoles',
    'suggestedCapabilities',
  ])('rejects duplicate entries in %s', (key) => {
    expect(() =>
      PortableWorkDefinitionSchema.parse({ ...definition, [key]: ['a', 'a'] }),
    ).toThrow();
  });

  it.each(PORTABLE_WORK_RESERVED_CONFIGURATION_KEYS)(
    'rejects reserved configuration default %s',
    (key) => {
      expect(() =>
        PortableWorkDefinitionSchema.parse({
          ...definition,
          configurationDefaults: { [key]: 'x' },
        }),
      ).toThrow();
    },
  );

  it('lists the protocol reserved keys exactly once each', () => {
    expect(PORTABLE_WORK_RESERVED_CONFIGURATION_KEYS).toHaveLength(21);
    expect(new Set(PORTABLE_WORK_RESERVED_CONFIGURATION_KEYS).size).toBe(21);
  });

  it.each([
    ['unknown top-level key', { ...definition, extra: 1 }],
    ['title over 160 characters', { ...definition, title: 'x'.repeat(161) }],
    ['empty title', { ...definition, title: '' }],
    ['empty intent', { ...definition, intent: '' }],
    ['empty outcome', { ...definition, outcome: '' }],
    ['empty array entry', { ...definition, rubricRefs: [''] }],
    ['wrong version', { ...definition, version: 2 }],
    [
      'nested configuration object',
      { ...definition, configurationDefaults: { a: { b: 1 } } },
    ],
  ])('rejects %s', (_name, value) => {
    expect(() => PortableWorkDefinitionSchema.parse(value)).toThrow();
  });

  it('accepts a title of exactly 160 characters', () => {
    expect(
      PortableWorkDefinitionSchema.parse({
        ...definition,
        title: 'x'.repeat(160),
      }).title,
    ).toHaveLength(160);
  });
});
