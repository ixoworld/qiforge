import { describe, expect, it } from 'vitest';
import { FeedbackContext } from './contract';

const context = {
  surface: 'workspace',
  locale: 'en',
  theme: 'dark',
  deviceClass: 'desktop',
  viewportBucket: 'wide',
  network: 'testnet',
} as const;

describe('FeedbackContext', () => {
  it.each([
    ['en', 'en'],
    ['en-gb', 'en-GB'],
    ['EN-GB', 'en-GB'],
    ['es-419', 'es-419'],
    ['fil', 'fil'],
  ])('accepts the locale %j as %j', (raw, canonical) => {
    expect(FeedbackContext.parse({ ...context, locale: raw }).locale).toBe(
      canonical,
    );
  });

  it.each([
    'en-JohnSmit',
    'en-Tbilisi',
    'en-GB-u-ca-buddhist',
    'x-john',
    'english',
    'en_GB',
    '',
  ])('refuses the locale %j: only a language and a region', (locale) => {
    expect(FeedbackContext.safeParse({ ...context, locale }).success).toBe(
      false,
    );
  });

  it.each(['1.4.0', '1.5.0-rc.2', '2.0.0-beta', '1.4.0+4f2ea36', '4f2ea36'])(
    'accepts the Portal build %j',
    (portalBuildVersion) => {
      expect(
        FeedbackContext.safeParse({ ...context, portalBuildVersion }).success,
      ).toBe(true);
    },
  );

  it.each([
    ['an 80-character string', 'a'.repeat(80)],
    ['a 41-character sha', 'a'.repeat(41)],
    ['free text', 'portal-build-for-john'],
    ['a free-text pre-release', '1.4.0-johnsmith'],
    ['a short hex', 'abc12'],
  ])('refuses %s as the Portal build', (_label, portalBuildVersion) => {
    expect(
      FeedbackContext.safeParse({ ...context, portalBuildVersion }).success,
    ).toBe(false);
  });
});
