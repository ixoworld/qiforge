export {
  getModelForRole,
  getProviderChatModel,
  getProviderConfig,
  getLLMProvider,
  type ProviderModelRole,
} from './llm-provider.js';

export {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  TIER_DISPLAY,
  buildModelListing,
  getCatalogEntry,
  getDefaultModelId,
  isAllowedModel,
  type ModelCatalogEntry,
  type ModelFamily,
  type ModelListItem,
  type ModelListing,
  type ModelPrice,
  type ModelTier,
} from './model-catalog.js';

// `openrouter-pricing.js` (fetch + cache) is consumed directly by the models
// module — intentionally not re-exported here to keep it an implementation
// detail rather than part of the llm surface.
