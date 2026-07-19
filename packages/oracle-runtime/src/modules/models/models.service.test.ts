import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  type ModelPrice,
} from '../../llm/model-catalog.js';
import { fetchOpenRouterPrices } from '../../llm/openrouter-pricing.js';
import { ModelsService } from './models.service.js';

vi.mock('../../llm/openrouter-pricing.js', () => ({
  fetchOpenRouterPrices: vi.fn(async () => new Map<string, ModelPrice>()),
  resetOpenRouterPriceCache: vi.fn(),
}));

describe('ModelsService', () => {
  beforeEach(() => {
    vi.mocked(fetchOpenRouterPrices).mockResolvedValue(
      new Map<string, ModelPrice>(),
    );
    delete process.env.DEFAULT_MODEL;
    delete process.env.MODEL_PRICE_MARKUP;
  });

  it('returns the whole catalog priced with the configured markup', async () => {
    const service = new ModelsService(
      new ConfigService({ MODEL_PRICE_MARKUP: 2 }),
    );

    const listing = await service.listModels();

    expect(listing.models).toHaveLength(MODEL_CATALOG.length);
    expect(listing.default).toBe(DEFAULT_MODEL_ID);
    const nano = listing.models.find((m) => m.id === DEFAULT_MODEL_ID);
    // baseline 0.20 in × 2
    expect(nano?.pricing.inputPerMillion).toBe(0.4);
  });

  it('defaults the markup to 1.6 when unset', async () => {
    const service = new ModelsService(new ConfigService({}));

    const listing = await service.listModels();

    const nano = listing.models.find((m) => m.id === DEFAULT_MODEL_ID);
    // baseline 0.20 in × 1.6
    expect(nano?.pricing.inputPerMillion).toBe(0.32);
  });

  it('prefers live prices when the fetch returns them', async () => {
    vi.mocked(fetchOpenRouterPrices).mockResolvedValue(
      new Map<string, ModelPrice>([
        [DEFAULT_MODEL_ID, { inputPerMillion: 5, outputPerMillion: 50 }],
      ]),
    );
    const service = new ModelsService(
      new ConfigService({ MODEL_PRICE_MARKUP: 1 }),
    );

    const listing = await service.listModels();

    const nano = listing.models.find((m) => m.id === DEFAULT_MODEL_ID);
    expect(nano?.pricing.inputPerMillion).toBe(5);
  });

  it('honours DEFAULT_MODEL for the default id', async () => {
    process.env.DEFAULT_MODEL = 'anthropic/claude-sonnet-5';
    const service = new ModelsService(new ConfigService({}));

    const listing = await service.listModels();

    expect(listing.default).toBe('anthropic/claude-sonnet-5');
    expect(listing.models.find((m) => m.isDefault)?.id).toBe(
      'anthropic/claude-sonnet-5',
    );
  });
});
