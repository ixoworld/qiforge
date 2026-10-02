import { describe, expect, it } from 'vitest';
import { assertOrigin, jsonObject, readTranscriptionLimits } from './protocol';
const config = {
  TRANSCRIPTION_ENABLED: 'true',
  TRANSCRIPTION_DAILY_SECONDS: '600',
  TRANSCRIPTION_ALLOWED_ORIGINS: 'https://portal.example',
};
describe('transcription admission configuration', () => {
  it('is off unless explicitly enabled and never invents a daily allowance', () => {
    expect(() => readTranscriptionLimits({})).toThrow('disabled');
    expect(() =>
      readTranscriptionLimits({ TRANSCRIPTION_ENABLED: 'true' }),
    ).toThrow('not_configured');
    expect(readTranscriptionLimits(config).maxDurationMs).toBe(60000);
  });
  it.each([
    '*',
    'https://portal.example/path',
    'http://portal.example',
    'null',
  ])('rejects unsafe origin config %s', (origin) => {
    expect(() =>
      readTranscriptionLimits({
        ...config,
        TRANSCRIPTION_ALLOWED_ORIGINS: origin,
      }),
    ).toThrow('not_configured');
  });
  it('validates exact origins and bounded integer limits', () => {
    const limits = readTranscriptionLimits(config);
    expect(() => assertOrigin(null, limits)).toThrow('origin_forbidden');
    expect(() => assertOrigin('https://portal.example.evil', limits)).toThrow(
      'origin_forbidden',
    );
    expect(() =>
      readTranscriptionLimits({ ...config, TRANSCRIPTION_MAX_SECONDS: '301' }),
    ).toThrow('not_configured');
    expect(() =>
      readTranscriptionLimits({ ...config, TRANSCRIPTION_DAILY_SECONDS: '20' }),
    ).toThrow('not_configured');
  });
  it.each(['null', '[]', '1', 'invalid'])(
    'rejects nonobject JSON %s',
    (raw) => {
      expect(() => jsonObject(raw)).toThrow('invalid_message');
    },
  );
});
