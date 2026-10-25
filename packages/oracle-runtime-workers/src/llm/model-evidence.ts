import { AIMessage } from '@langchain/core/messages';

export interface ProviderModelEvidence {
  modelId: string;
  evidence: 'provider_response';
  callId: string;
}

function isModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(value)
  );
}

export function providerModelEvidence(
  output: unknown,
  callId: unknown,
): ProviderModelEvidence | undefined {
  if (
    typeof callId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callId)
  )
    return;
  if (!AIMessage.isInstance(output)) return;
  const metadata = output.response_metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return;
  const candidates = [metadata.model_name, metadata.model].filter(
    (value) => value !== undefined,
  );
  if (!candidates.every(isModelId)) return;
  const modelId = candidates[0];
  if (!modelId || candidates.some((value) => value !== modelId)) return;
  return { modelId, evidence: 'provider_response', callId };
}
