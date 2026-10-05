import { describe, expect, it } from 'vitest';
import { feedbackFingerprint, screenFeedbackText } from './privacy';

describe('screenFeedbackText', () => {
  it('trims ordinary feedback and passes it through unchanged otherwise', () => {
    expect(screenFeedbackText('  The answer needs citations.  ')).toEqual({
      ok: true,
      text: 'The answer needs citations.',
    });
    // Product words and plain URLs are not identifiers.
    expect(
      screenFeedbackText(
        'Tokens were explained badly; see https://docs.ixo.world/guide for the right version 2.1',
      ).ok,
    ).toBe(true);
  });

  it('rejects empty text after trimming', () => {
    expect(screenFeedbackText(' \n\t ')).toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  it.each([
    ['email address', 'Email me at person@example.com'],
    ['Matrix identifier', 'My Matrix ID is @person:matrix.example'],
    ['decentralized identifier', 'My DID is did:ixo:1234'],
    ['wallet address', 'Use wallet ixo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'],
    ['wallet address', 'Pay 0x52908400098527886E0F7030069857D2E4169EE7'],
    ['phone number', 'Call me on +1 415 555 2671'],
    ['credential', 'api_key=secret-value'],
    ['credential', 'password: hunter22'],
    [
      'credential',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    ],
    ['secret-bearing URL', 'See https://example.com/path?access_token=abc'],
    // Punctuation and brackets around a number, and a number after a date.
    ['phone number', 'Call me on 0825550123.'],
    ['phone number', 'Call me (0825550123)'],
    ['phone number', 'Ring +27 82 555 0123, thanks'],
    ['phone number', 'On 2026-10-05 call 0825550123'],
    ['phone number', 'Budget 1 000 000 or call 0825550123'],
    // Invisible and compatibility characters do not split an identifier.
    ['decentralized identifier', 'My DID is did\u200b:ixo:1234'],
    ['decentralized identifier', 'My DID is d\u2060id:ixo:1234'],
    ['email address', 'Email person\uff20example.com'],
    ['Matrix identifier', 'I am \uff20person:matrix.example'],
  ])('rejects a %s: %j', (kind, text) => {
    expect(screenFeedbackText(text)).toEqual({
      ok: false,
      reason: 'personal_data',
      kind,
    });
  });

  it.each([
    'On 2026-10-05 the agent forgot my earlier question.',
    'It mixed up results from 2019 - 2024 and older ones.',
    'It said the pool holds 1 000 000 tokens, which is wrong.',
    'The total was 1,250,000 and not 125,000.',
    'Version 2.1.3 of the guide is outdated.',
  ])('does not mistake numbers for a phone number: %j', (text) => {
    expect(screenFeedbackText(text)).toEqual({ ok: true, text });
  });

  it('sends what it screened: compatibility forms folded, format characters removed', () => {
    expect(screenFeedbackText(' Ｇreat\u200b answer ')).toEqual({
      ok: true,
      text: 'Great answer',
    });
  });
});

describe('feedbackFingerprint', () => {
  const secret = 'a-private-secret-of-at-least-32-chars';

  it('is stable for one secret and namespaced, without exposing the source value', async () => {
    const first = await feedbackFingerprint(secret, 'user', 'did:ixo:user');
    expect(await feedbackFingerprint(secret, 'user', 'did:ixo:user')).toBe(
      first,
    );
    expect(first).toMatch(/^user_[a-f0-9]{64}$/);
    expect(first).not.toContain('did:ixo:user');
    expect(
      await feedbackFingerprint(secret, 'session', 'did:ixo:user'),
    ).not.toBe(first.replace(/^user_/, 'session_'));
  });

  it('changes with the secret, so it cannot be recomputed without it', async () => {
    expect(await feedbackFingerprint(secret, 'user', 'did:ixo:user')).not.toBe(
      await feedbackFingerprint(`${secret}!`, 'user', 'did:ixo:user'),
    );
  });

  it('separates parts unambiguously', async () => {
    expect(await feedbackFingerprint(secret, 'message', 'ab', 'c')).not.toBe(
      await feedbackFingerprint(secret, 'message', 'a', 'bc'),
    );
  });

  it('matches the Node runtime derivation (a vector from node:crypto createHmac)', async () => {
    // createHmac('sha256', secret).update('session\0did:ixo:user\0s-1').digest('hex')
    expect(
      await feedbackFingerprint(secret, 'session', 'did:ixo:user', 's-1'),
    ).toBe(
      'session_a31c61b32bee4800a277db6b55795919527609ab91d3c63b00a04151ff616967',
    );
  });
});
