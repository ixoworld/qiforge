import { describe, expect, it } from 'vitest';
import { proseBlockTypes } from './blocknote-bridge.js';
import {
  IXO_BLOCK_TYPES,
  IXO_WRITABLE_PROPS,
  LOCKED_BLOCK_TYPES,
  REDACTED_VALUE,
  classifyBlockType,
  filterWritableProps,
  isTextEditable,
  redactProps,
} from './prop-policy.js';

describe('prop-policy: classification', () => {
  it("treats BlockNote's own block types as prose", () => {
    const prose = proseBlockTypes();
    expect(prose.has('paragraph')).toBe(true);
    expect(prose.has('heading')).toBe(true);
    for (const type of prose) {
      expect(classifyBlockType(type)).toBe('prose');
      expect(isTextEditable(type)).toBe(true);
    }
  });

  it('treats every custom IXO block as label-only', () => {
    for (const type of IXO_BLOCK_TYPES) {
      if (LOCKED_BLOCK_TYPES.includes(type)) continue;
      expect(classifyBlockType(type)).toBe('ixo');
      expect(isTextEditable(type)).toBe(false);
    }
  });

  it('locks secrets and skills blocks entirely', () => {
    expect(LOCKED_BLOCK_TYPES).toEqual(['secrets', 'skills']);
    for (const type of LOCKED_BLOCK_TYPES) {
      expect(classifyBlockType(type)).toBe('locked');
      expect(isTextEditable(type)).toBe(false);
    }
  });

  it('treats an unrecognised block type as label-only, not as prose', () => {
    expect(classifyBlockType('someFutureBlock')).toBe('unknown');
    expect(isTextEditable('someFutureBlock')).toBe(false);
    const result = filterWritableProps('someFutureBlock', {
      title: 'ok',
      mystery: 'no',
    });
    expect(result.allowed).toEqual({ title: 'ok' });
    expect(result.rejected.map((r) => r.prop)).toEqual(['mystery']);
  });

  it('has no overlap between the prose set and the custom set', () => {
    const prose = proseBlockTypes();
    const overlap = IXO_BLOCK_TYPES.filter((type) => prose.has(type));
    expect(overlap).toEqual([]);
  });
});

describe('prop-policy: prop allowlist', () => {
  it('lets prose blocks take any prop, normalised to strings', () => {
    const result = filterWritableProps('heading', {
      level: 2,
      textAlignment: 'center',
      backgroundColor: 'blue',
    });
    expect(result.rejected).toEqual([]);
    expect(result.allowed).toEqual({
      level: '2',
      textAlignment: 'center',
      backgroundColor: 'blue',
    });
  });

  it('allows only title and description on a custom IXO block', () => {
    const result = filterWritableProps('checkbox', {
      title: 'Review the draft',
      description: 'before Friday',
    });
    expect(result.rejected).toEqual([]);
    expect(result.allowed).toEqual({
      title: 'Review the draft',
      description: 'before Friday',
    });
    expect(IXO_WRITABLE_PROPS).toEqual(['title', 'description']);
  });

  it('refuses behavioural props and names the offending prop', () => {
    const result = filterWritableProps('action', {
      title: 'Send it',
      conditions: '{"enabled":true}',
      authorisedActors: 'did:ixo:abc',
      type: 'qi/email.send',
      inputs: '{"to":"x"}',
      parentCapability: 'bafy...',
    });

    expect(result.allowed).toEqual({ title: 'Send it' });
    expect(result.rejected.map((r) => r.prop).sort()).toEqual([
      'authorisedActors',
      'conditions',
      'inputs',
      'parentCapability',
      'type',
    ]);
    for (const entry of result.rejected) {
      expect(entry.reason).toContain(entry.prop);
      expect(entry.reason).toContain('action');
    }
  });

  it('refuses every prop on a locked block, including title', () => {
    for (const type of LOCKED_BLOCK_TYPES) {
      const result = filterWritableProps(type, {
        title: 'nice try',
        value: 'secret',
      });
      expect(result.allowed).toEqual({});
      expect(result.rejected.map((r) => r.prop).sort()).toEqual([
        'title',
        'value',
      ]);
      for (const entry of result.rejected) {
        expect(entry.reason).toContain(type);
      }
    }
  });

  it('returns nothing to write for an empty patch', () => {
    expect(filterWritableProps('paragraph', {})).toEqual({
      allowed: {},
      rejected: [],
    });
  });
});

describe('prop-policy: redaction', () => {
  it('redacts every value on a secrets block but keeps the keys', () => {
    const redacted = redactProps('secrets', {
      title: 'API keys',
      value: 'sk-live-abc123',
      secretRef: 'vault://x',
    });
    expect(redacted).toEqual({
      title: REDACTED_VALUE,
      value: REDACTED_VALUE,
      secretRef: REDACTED_VALUE,
    });
  });

  it('leaves other block types untouched, including skills', () => {
    const props = { title: 'Skill picker', skillIds: 'a,b' };
    expect(redactProps('skills', props)).toBe(props);
    expect(redactProps('paragraph', props)).toBe(props);
    expect(redactProps('checkbox', props)).toBe(props);
  });
});
