import { describe, expect, it } from 'vitest';
import { secretLiteralPaths } from './input-policy';

describe('secret input refusal', () => {
  it('refuses a secret wrapped in braces that is not a step output reference', () => {
    expect(secretLiteralPaths({ pin: '{{1234}}' })).toEqual(['pin']);
    expect(
      secretLiteralPaths({
        mnemonic: '{{abandon ability able about above absent}}',
      }),
    ).toEqual(['mnemonic']);
  });

  it('accepts a reference to an output of a step the flow has', () => {
    expect(
      secretLiteralPaths(
        { pin: '{{form.output.answers.pin}}' },
        new Set(['form']),
      ),
    ).toEqual([]);
  });

  it('refuses a reference to a step the flow does not have', () => {
    expect(
      secretLiteralPaths({ pin: '{{ghost.output.pin}}' }, new Set(['form'])),
    ).toEqual(['pin']);
  });

  it.each([
    'matrixAccessToken',
    'matrixPassword',
    'matrixRecoveryPhrase',
    'openRouterApiKeyPlaintext',
  ])('refuses a literal %s', (name) => {
    expect(secretLiteralPaths({ [name]: 'plaintext' })).toEqual([name]);
  });

  it('leaves non-secret inputs alone', () => {
    expect(
      secretLiteralPaths({ to: 'a@b.c', body: '{{1234}}', nested: { x: 1 } }),
    ).toEqual([]);
  });
});
