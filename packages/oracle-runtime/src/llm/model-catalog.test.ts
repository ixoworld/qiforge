import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  buildModelListing,
  getCatalogEntry,
  getDefaultModelId,
  getModelCapabilities,
  isAllowedModel,
  type ModelPrice,
} from './model-catalog.js';

describe('model-catalog', () => {
  const originalDefault = process.env.DEFAULT_MODEL;
  afterEach(() => {
    if (originalDefault === undefined) delete process.env.DEFAULT_MODEL;
    else process.env.DEFAULT_MODEL = originalDefault;
  });

  describe('isAllowedModel', () => {
    it('accepts every catalog id', () => {
      for (const entry of MODEL_CATALOG) {
        expect(isAllowedModel(entry.id)).toBe(true);
      }
    });

    it('rejects unknown ids and nullish values', () => {
      expect(isAllowedModel('openai/definitely-not-real')).toBe(false);
      expect(isAllowedModel(undefined)).toBe(false);
      expect(isAllowedModel(null)).toBe(false);
      expect(isAllowedModel('')).toBe(false);
    });
  });

  describe('getDefaultModelId', () => {
    it('defaults to GPT-5.4 Nano', () => {
      delete process.env.DEFAULT_MODEL;
      expect(getDefaultModelId()).toBe(DEFAULT_MODEL_ID);
      expect(DEFAULT_MODEL_ID).toBe('openai/gpt-5.4-nano');
    });

    it('honours the DEFAULT_MODEL env override', () => {
      process.env.DEFAULT_MODEL = 'anthropic/claude-sonnet-5';
      expect(getDefaultModelId()).toBe('anthropic/claude-sonnet-5');
    });

    it('ignores a blank override', () => {
      process.env.DEFAULT_MODEL = '   ';
      expect(getDefaultModelId()).toBe(DEFAULT_MODEL_ID);
    });
  });

  it('has the default model in the catalog', () => {
    expect(getCatalogEntry(DEFAULT_MODEL_ID)).toBeDefined();
  });

  describe('getModelCapabilities', () => {
    it('reports GPT-5.4 Nano as image+file but not audio/video', () => {
      expect(getModelCapabilities(DEFAULT_MODEL_ID)).toEqual({
        image: true,
        file: true,
        audio: false,
        video: false,
      });
    });

    it('treats unknown ids as text-only', () => {
      expect(getModelCapabilities('does/not-exist')).toEqual({
        image: false,
        file: false,
        audio: false,
        video: false,
      });
    });

    it("keeps each entry's display `vision` flag in sync with image capability", () => {
      for (const entry of MODEL_CATALOG) {
        expect(entry.vision).toBe(getModelCapabilities(entry.id).image);
      }
    });
  });

  describe('buildModelListing', () => {
    it('applies the markup to baseline prices when no live price is given', () => {
      const listing = buildModelListing({
        markup: 2,
        defaultModelId: DEFAULT_MODEL_ID,
      });
      const nano = listing.models.find((m) => m.id === DEFAULT_MODEL_ID);
      expect(nano).toBeDefined();
      // baseline 0.20 in / 1.25 out × 2
      expect(nano?.pricing.inputPerMillion).toBe(0.4);
      expect(nano?.pricing.outputPerMillion).toBe(2.5);
      expect(nano?.pricing.currency).toBe('USD');
      expect(nano?.pricing.unit).toBe('per_million_tokens');
    });

    it('prefers live prices over baselines', () => {
      const livePrices = new Map<string, ModelPrice>([
        [DEFAULT_MODEL_ID, { inputPerMillion: 1, outputPerMillion: 10 }],
      ]);
      const listing = buildModelListing({
        livePrices,
        markup: 1.5,
        defaultModelId: DEFAULT_MODEL_ID,
      });
      const nano = listing.models.find((m) => m.id === DEFAULT_MODEL_ID);
      expect(nano?.pricing.inputPerMillion).toBe(1.5);
      expect(nano?.pricing.outputPerMillion).toBe(15);
    });

    it('flags exactly the default model and echoes it', () => {
      const listing = buildModelListing({
        markup: 1.6,
        defaultModelId: DEFAULT_MODEL_ID,
      });
      expect(listing.default).toBe(DEFAULT_MODEL_ID);
      const defaults = listing.models.filter((m) => m.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]?.id).toBe(DEFAULT_MODEL_ID);
    });

    it('never leaks the raw price or the markup multiplier', () => {
      const listing = buildModelListing({
        markup: 1.6,
        defaultModelId: DEFAULT_MODEL_ID,
      });
      for (const model of listing.models) {
        expect(model).not.toHaveProperty('baselinePrice');
        expect(model).not.toHaveProperty('rawPricing');
        expect(model.pricing).not.toHaveProperty('markup');
      }
    });

    it('orders cheapest tier first', () => {
      const listing = buildModelListing({
        markup: 1.6,
        defaultModelId: DEFAULT_MODEL_ID,
      });
      const rank = { everyday: 0, balanced: 1, top: 2 } as const;
      const tiers = listing.models.map((m) => rank[m.tier]);
      expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    });

    it('gives every model a cost label, badge and blurb', () => {
      const listing = buildModelListing({
        markup: 1.6,
        defaultModelId: DEFAULT_MODEL_ID,
      });
      for (const model of listing.models) {
        expect(['$', '$$', '$$$']).toContain(model.costLabel);
        expect(model.badge.length).toBeGreaterThan(0);
        expect(model.blurb.length).toBeGreaterThan(0);
      }
    });
  });
});
