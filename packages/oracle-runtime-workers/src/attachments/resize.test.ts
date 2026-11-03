/**
 * `resizeForModel` over a fake Images binding: only rasters with a side over
 * the limit are transformed (scale-down to fit a square of the limit, JPEG),
 * and every other case — no binding, an unsupported type, SVG, an image
 * within the limit, a binding error — returns the input unchanged.
 */
import { describe, expect, it } from 'vitest';
import { fakeImages } from './fixtures/fake-images';
import { RESIZE_JPEG_QUALITY, RESIZE_MAX_EDGE, resizeForModel } from './resize';

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

function recordingLogger() {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      log: () => undefined,
      warn: (message: string) => warnings.push(message),
      error: () => undefined,
    },
  };
}

describe('resizeForModel', () => {
  it('returns the input unchanged without the binding', async () => {
    const out = await resizeForModel(PNG, 'image/png', undefined);
    expect(out.bytes).toBe(PNG);
    expect(out.mimetype).toBe('image/png');
  });

  it('downscales an image wider than the limit to a JPEG within the default edge and quality', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 7, 7]);
    const images = fakeImages({ width: 4032, output: jpeg });
    const out = await resizeForModel(PNG, 'image/png', images);
    expect(out).toEqual({ bytes: jpeg, mimetype: 'image/jpeg' });
    expect(images.transforms).toEqual([
      { width: RESIZE_MAX_EDGE, height: RESIZE_MAX_EDGE, fit: 'scale-down' },
    ]);
    expect(images.outputs).toEqual([
      {
        format: 'image/jpeg',
        quality: RESIZE_JPEG_QUALITY,
        background: '#ffffff',
      },
    ]);
    // `info()` and `input()` each read the original bytes.
    expect(images.seen).toEqual([PNG, PNG]);
  });

  it('downscales a tall image whose width is within the limit', async () => {
    const images = fakeImages({ width: 1170, height: 2532 });
    const out = await resizeForModel(PNG, 'image/png', images);
    expect(out.mimetype).toBe('image/jpeg');
    expect(images.transforms).toEqual([
      { width: RESIZE_MAX_EDGE, height: RESIZE_MAX_EDGE, fit: 'scale-down' },
    ]);
  });

  it('honours a custom edge and quality', async () => {
    const images = fakeImages({ width: 1000 });
    await resizeForModel(PNG, 'image/webp', images, {
      maxWidth: 512,
      quality: 60,
    });
    expect(images.transforms).toEqual([
      { width: 512, height: 512, fit: 'scale-down' },
    ]);
    expect(images.outputs[0]?.quality).toBe(60);
  });

  it('never upscales: an image within the limit on both sides is not transformed', async () => {
    for (const [width, height] of [
      [RESIZE_MAX_EDGE, RESIZE_MAX_EDGE],
      [640, 480],
      [480, RESIZE_MAX_EDGE],
    ]) {
      const images = fakeImages({ width, height });
      const out = await resizeForModel(PNG, 'image/jpeg', images);
      expect(out.bytes).toBe(PNG);
      expect(out.mimetype).toBe('image/jpeg');
      expect(images.transforms).toEqual([]);
      expect(images.outputs).toEqual([]);
    }
  });

  it('skips SVG and types the binding does not take without calling it', async () => {
    for (const type of ['image/svg+xml', 'image/bmp', 'image/heic']) {
      const images = fakeImages({ width: 5000 });
      const out = await resizeForModel(PNG, type, images);
      expect(out).toEqual({ bytes: PNG, mimetype: type });
      expect(images.seen).toEqual([]);
    }
  });

  it('leaves an image the binding reports as SVG untouched', async () => {
    const images = fakeImages({ svg: true });
    const out = await resizeForModel(PNG, 'image/png', images);
    expect(out.bytes).toBe(PNG);
    expect(images.transforms).toEqual([]);
  });

  it('reads the type without parameters or case', async () => {
    const images = fakeImages({ width: 2000 });
    await resizeForModel(PNG, 'Image/PNG; charset=binary', images);
    expect(images.transforms).toHaveLength(1);
  });

  const failingSteps: Array<'info' | 'output'> = ['info', 'output'];
  it.each(failingSteps)(
    'returns the original and warns once when %s throws',
    async (fail) => {
      const images = fakeImages({ width: 4000, fail });
      const { warnings, logger } = recordingLogger();
      const out = await resizeForModel(PNG, 'image/png', images, { logger });
      expect(out).toEqual({ bytes: PNG, mimetype: 'image/png' });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/image resize failed .*sending the original/);
    },
  );

  it('returns the original when the binding yields no bytes', async () => {
    const images = fakeImages({ width: 4000, output: new Uint8Array(0) });
    const { warnings, logger } = recordingLogger();
    const out = await resizeForModel(PNG, 'image/png', images, { logger });
    expect(out.bytes).toBe(PNG);
    expect(warnings).toHaveLength(1);
  });
});
