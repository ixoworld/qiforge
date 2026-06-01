// Compatibility shim — the actual implementation now lives in
// `@ixo/oracle-runtime` (see `src/llm/llm-provider.ts`). This file exists only
// to keep the vestigial `apps/app/src/graph/*` files compiling until TASK-32d
// deletes them. New code should import from `@ixo/oracle-runtime` directly.
export {
  getModelForRole,
  getProviderChatModel,
  getProviderConfig,
  getLLMProvider,
  type ProviderModelRole as ModelRole,
} from '@ixo/oracle-runtime';

// Pricing-cache subsystem was removed from the runtime when the new credits
// plugin moved to a host-supplied `modelPricingLookup`. Vestigial apps/app
// files still reference these — provide no-op stubs until 32d wipes them.
export interface ModelPricing {
  inputPricePerMillionTokens: number;
  outputPricePerMillionTokens: number;
}
export const getModelPricing = (_modelId: string): ModelPricing | null => null;
