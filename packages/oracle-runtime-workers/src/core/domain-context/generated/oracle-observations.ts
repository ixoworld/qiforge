export const OBSERVATION_VERSION = 'ixo.professional-oracle.observation/v1' as const;
export const ASSESSMENTS = [
  'consistent',
  'apparent_inconsistency',
  'ambiguous_rule',
  'insufficient_evidence',
  'suspected_check_error',
] as const;
export const STAGES = ['context', 'facts', 'review', 'delivery'] as const;
export const UNCERTAINTIES = ['unknown', 'low', 'medium', 'high'] as const;

export interface GoverningRevision {
  domainDid: string | null;
  configuredRevision: string | null;
  loadedRevision: string | null;
}

export interface ObservationInput {
  observationId: string;
  runId: string;
  stage: (typeof STAGES)[number];
  observedAt: string;
  ruleRef: string;
  governingRevision: GoverningRevision;
  evidenceRefs: string[];
  check: { id: string; version: string };
  assessment: (typeof ASSESSMENTS)[number];
  uncertainty: (typeof UNCERTAINTIES)[number];
  suggestedFollowUp?: string;
}

export interface ProfessionalOracleObservation extends ObservationInput {
  schemaVersion: typeof OBSERVATION_VERSION;
  mode: 'advisory';
}

export interface ObservationOptions {
  mode: 'advisory';
  emit: (observation: ProfessionalOracleObservation) => void | Promise<void>;
  schedule?: (work: Promise<void>) => void;
  onDiagnostic?: (code: 'invalid-observation' | 'observer-failed' | 'scheduler-failed') => void;
}

function bounded(value: unknown, limit = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/u.test(value);
}

function reference(value: unknown): value is string {
  return bounded(value) && !/\s|[?#&=]/u.test(value.replace(/#[A-Za-z0-9._:-]+$/u, ''));
}

/** Copies only contract fields. Callers pass identifiers, never source payloads or credentials. */
export function createObservation(input: ObservationInput): ProfessionalOracleObservation {
  if (!input || typeof input !== 'object' ||
    !bounded(input.observationId) || !bounded(input.runId) || !reference(input.ruleRef) ||
    !STAGES.includes(input.stage) || !ASSESSMENTS.includes(input.assessment) ||
    !UNCERTAINTIES.includes(input.uncertainty) ||
    !bounded(input.observedAt, 40) || !/^\d{4}-\d{2}-\d{2}T.*Z$/u.test(input.observedAt) ||
    !Number.isFinite(Date.parse(input.observedAt)) ||
    !input.check || !reference(input.check.id) || !bounded(input.check.version, 80) ||
    !input.governingRevision || !Array.isArray(input.evidenceRefs) ||
    input.evidenceRefs.length > 64 || !input.evidenceRefs.every(reference) ||
    (input.suggestedFollowUp !== undefined && !bounded(input.suggestedFollowUp, 1000))) {
    throw new Error('Invalid professional oracle observation');
  }
  for (const value of [input.governingRevision.domainDid, input.governingRevision.configuredRevision, input.governingRevision.loadedRevision]) {
    if (value !== null && !reference(value)) throw new Error('Invalid governing revision reference');
  }
  return Object.freeze({
    schemaVersion: OBSERVATION_VERSION,
    mode: 'advisory',
    observationId: input.observationId,
    runId: input.runId,
    stage: input.stage,
    observedAt: input.observedAt,
    ruleRef: input.ruleRef,
    governingRevision: Object.freeze({
      domainDid: input.governingRevision.domainDid,
      configuredRevision: input.governingRevision.configuredRevision,
      loadedRevision: input.governingRevision.loadedRevision,
    }),
    evidenceRefs: Object.freeze([...input.evidenceRefs]) as unknown as string[],
    check: Object.freeze({ id: input.check.id, version: input.check.version }),
    assessment: input.assessment,
    uncertainty: input.uncertainty,
    ...(input.suggestedFollowUp === undefined ? {} : { suggestedFollowUp: input.suggestedFollowUp }),
  });
}

/** Observation and diagnostic failures never propagate into the operation being observed. */
export function dispatchObservation(
  input: ObservationInput,
  options: ObservationOptions | undefined,
  replay = false,
): void {
  if (!options || options.mode !== 'advisory' || replay) return;
  const diagnostic = (code: Parameters<NonNullable<ObservationOptions['onDiagnostic']>>[0]) => {
    try { options.onDiagnostic?.(code); } catch {}
  };
  let observation: ProfessionalOracleObservation;
  try { observation = createObservation(input); }
  catch { diagnostic('invalid-observation'); return; }
  const work = Promise.resolve().then(() => options.emit(observation)).then(
    () => undefined,
    () => { diagnostic('observer-failed'); },
  );
  try { options.schedule?.(work); }
  catch { diagnostic('scheduler-failed'); }
}
