import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildModelListing,
  getDefaultModelId,
  type ModelListing,
} from '../../llm/model-catalog.js';
import { fetchOpenRouterPrices } from '../../llm/openrouter-pricing.js';

/**
 * Assembles the user-facing model listing: the curated catalog, priced with
 * live OpenRouter numbers (falling back to baselines) and the deployment's
 * markup, plus the effective default model. The heavy lifting (fetch + markup)
 * is pure and lives in `llm/`; this service just supplies the config-derived
 * inputs and the price fetch.
 */
@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);

  constructor(private readonly config: ConfigService) {}

  async listModels(): Promise<ModelListing> {
    const markup = this.resolveMarkup();
    const livePrices = await fetchOpenRouterPrices();
    const listing = buildModelListing({
      livePrices,
      markup,
      defaultModelId: getDefaultModelId(),
    });
    this.logger.debug?.(
      `Listing ${listing.models.length} models (default=${listing.default}, markup=${markup}, livePrices=${livePrices.size})`,
    );
    return listing;
  }

  /**
   * The display markup. `ConfigService.get` can return the raw `process.env`
   * string (it is consulted before the zod-coerced value), so coerce here and
   * fall back to the default on anything non-positive/non-finite.
   */
  private resolveMarkup(): number {
    const raw = this.config.get<unknown>('MODEL_PRICE_MARKUP', 1.6);
    const markup = Number(raw);
    return Number.isFinite(markup) && markup > 0 ? markup : 1.6;
  }
}
