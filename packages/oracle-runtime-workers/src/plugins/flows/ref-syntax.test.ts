import { describe, expect, it } from 'vitest';
import {
  MAX_REF_SCAN_CHARS,
  referencesId,
  scanRefTokens,
  wholeRef,
} from './ref-syntax';

describe('ref-syntax', () => {
  it('finds each placeholder with its spacing', () => {
    expect(scanRefTokens('x {{ a.output.b }} y {{c}}')).toEqual([
      { start: 2, end: 18, ref: 'a.output.b', leading: ' ', trailing: ' ' },
      { start: 21, end: 26, ref: 'c', leading: '', trailing: '' },
    ]);
  });

  it('recognises only a single whole-string placeholder as a reference', () => {
    expect(wholeRef('{{ a.output.b }}')).toBe('a.output.b');
    expect(wholeRef('{{a}} {{b}}')).toBeUndefined();
    expect(wholeRef(' {{a}}')).toBeUndefined();
    expect(wholeRef('{{   }}')).toBeUndefined();
  });

  it('does not scan strings over the cap', () => {
    expect(scanRefTokens(`{{a}}${'x'.repeat(MAX_REF_SCAN_CHARS)}`)).toEqual([]);
  });

  it('finds a reference to an id at any depth, matching the id literally', () => {
    expect(referencesId({ v: { name: 'Hi {{form.output.n}}' } }, 'form')).toBe(
      true,
    );
    expect(referencesId(['{{form.output.n}}'], 'form')).toBe(true);
    expect(referencesId({ v: '{{formx.output.n}}' }, 'form')).toBe(false);
    // Regex metacharacters in an id are plain characters.
    expect(referencesId({ v: '{{a(b.output.n}}' }, 'a(b')).toBe(true);
    expect(referencesId({ v: '{{aXb.output.n}}' }, 'a.b')).toBe(false);
  });
});
