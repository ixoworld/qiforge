import { describe, expect, it } from 'vitest';
import type { ModelInputCapabilities } from '../../../llm/model-catalog.js';
import { routeAttachment } from './route.js';

const caps = (o: Partial<ModelInputCapabilities>): ModelInputCapabilities => ({
  image: false,
  file: false,
  audio: false,
  video: false,
  ...o,
});

describe('routeAttachment', () => {
  it('always parses plain text locally', () => {
    expect(routeAttachment('text', caps({}))).toBe('parse-local');
    expect(routeAttachment('text', caps({ image: true, file: true }))).toBe(
      'parse-local',
    );
  });

  it('sends native when the model supports the modality', () => {
    expect(routeAttachment('image', caps({ image: true }))).toBe('send-native');
    expect(routeAttachment('document', caps({ file: true }))).toBe(
      'send-native',
    );
    expect(routeAttachment('audio', caps({ audio: true }))).toBe('send-native');
    expect(routeAttachment('video', caps({ video: true }))).toBe('send-native');
  });

  it('extracts when the model lacks the modality', () => {
    expect(routeAttachment('image', caps({}))).toBe('model-extract');
    // image but not file → a document still gets extracted
    expect(routeAttachment('document', caps({ image: true }))).toBe(
      'model-extract',
    );
    expect(routeAttachment('audio', caps({ image: true, file: true }))).toBe(
      'model-extract',
    );
  });

  it('GPT-style caps (image+file, no a/v): pdf native, audio extracted', () => {
    const gpt = caps({ image: true, file: true });
    expect(routeAttachment('document', gpt)).toBe('send-native');
    expect(routeAttachment('image', gpt)).toBe('send-native');
    expect(routeAttachment('audio', gpt)).toBe('model-extract');
    expect(routeAttachment('video', gpt)).toBe('model-extract');
  });

  it('text-only caps: everything non-text is extracted', () => {
    const textOnly = caps({});
    for (const kind of [
      'image',
      'document',
      'audio',
      'video',
      'unknown',
    ] as const) {
      expect(routeAttachment(kind, textOnly)).toBe('model-extract');
    }
  });
});
