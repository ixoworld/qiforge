'use client';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { ModelInfo, ModelsResponse } from '../../types/model.type.js';
import { request } from '../../utils/request.js';
import { useOraclesConfig } from '../use-oracles-config.js';

// The catalog changes rarely (prices refresh server-side hourly); a generous
// staleTime keeps remounting pickers from refetching.
const MODELS_STALE_TIME_MS = 10 * 60 * 1000;

export interface UseModelsResult {
  /** The models a user can pick, cheapest tier first. */
  models: ModelInfo[];
  /** Id of the oracle's default model, or `undefined` while loading. */
  defaultModelId: string | undefined;
  /** The default model object, for convenience. */
  defaultModel: ModelInfo | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Fetch an oracle's model catalog for a picker (the ChatGPT/Claude-style
 * switcher). The endpoint is public, so this works before the user has an
 * active subscription. Feed the chosen `model.id` back into
 * `useChat({ ..., model })` to answer with it.
 *
 * ```tsx
 * const { models, defaultModelId } = useModels(oracleDid);
 * const [model, setModel] = useState<string | undefined>(defaultModelId);
 * const { sendMessage } = useChat({ oracleDid, sessionId, model, onPaymentRequiredError });
 * ```
 */
export function useModels(
  oracleDid: string,
  overrides?: { baseUrl?: string },
): UseModelsResult {
  const { config } = useOraclesConfig(oracleDid, overrides);
  const apiUrl = overrides?.baseUrl ?? config.apiUrl;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [oracleDid, 'models', apiUrl],
    queryFn: () => request<ModelsResponse>(`${apiUrl}/models`, 'GET'),
    enabled: Boolean(apiUrl),
    staleTime: MODELS_STALE_TIME_MS,
    retry: false,
  });

  const models = useMemo(() => data?.models ?? [], [data]);
  const defaultModelId = data?.default;
  const defaultModel = useMemo(
    () =>
      models.find((m) => m.id === defaultModelId) ??
      models.find((m) => m.isDefault),
    [models, defaultModelId],
  );

  return {
    models,
    defaultModelId,
    defaultModel,
    isLoading,
    error: error ?? null,
    refetch,
  };
}
