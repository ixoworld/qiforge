import type {
  DecisionAdapter,
  DecisionJudgmentMethod,
  DecisionJudgmentProvenance,
  DecisionProviderResult,
} from './types.js';

const PROVIDER_NATIVE: DecisionJudgmentMethod = { kind: 'provider-native' };

/**
 * What a validated provider result is recorded as: everything in the
 * evaluation's `judgment` except the Decision version.
 */
export type DecisionRecordedProvenance = Omit<
  DecisionJudgmentProvenance,
  'questionSetVersion'
>;

/**
 * Builds the provenance record for one validated provider result. An adapter
 * that declares no method is recorded as provider-native, which makes no claim
 * that its confidence is calibrated. Inference fields the adapter leaves out
 * come from its declared `capabilities` and `model` (and `modelVersion` for the
 * returned model), or are recorded as `custom` / `unknown`, so a record never
 * implies a pinned backend nobody asserted. Every nested object is copied, so
 * a caller mutating one record cannot change the next.
 */
export function recordedProvenance(
  adapter: DecisionAdapter,
  result: Pick<DecisionProviderResult, 'modelVersion' | 'provenance'>,
): DecisionRecordedProvenance {
  const provenance = result.provenance;
  const returnedModel = provenance?.returnedModel ?? result.modelVersion;
  return {
    method: { ...(provenance?.method ?? PROVIDER_NATIVE) },
    ...(provenance?.calibration
      ? { calibration: { ...provenance.calibration } }
      : {}),
    apiDialect:
      provenance?.apiDialect ?? adapter.capabilities?.apiDialect ?? 'custom',
    requestedModel: provenance?.requestedModel ?? adapter.model,
    ...(returnedModel ? { returnedModel } : {}),
    ...(provenance?.functionVersion
      ? { functionVersion: provenance.functionVersion }
      : {}),
    modelPinning:
      provenance?.modelPinning ??
      adapter.capabilities?.modelPinning ??
      'unknown',
    ...(provenance?.providerArtifactRef
      ? { providerArtifactRef: provenance.providerArtifactRef }
      : {}),
    ...(provenance?.calibrationProfileRef
      ? { calibrationProfileRef: provenance.calibrationProfileRef }
      : {}),
  };
}
