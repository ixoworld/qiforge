import { dispatchObservation } from './generated/oracle-observations';
import type { ObservationOptions } from './generated/oracle-observations';
import type { DomainSnapshot } from './types';

interface RulePractice {
  ruleRef: string;
  documentRef: string;
  implementationStatus: string;
}

export interface ProfessionalContext {
  version: '1';
  observation: { mode: 'advisory'; modelAssessments: false };
  serviceScope: { summary: string; exclusions: string[]; protocols: string[] };
  methods: { id: string; documentRef: string; resourceRefs: string[] }[];
  rulePractices: RulePractice[];
}

const text = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const refs = (value: unknown, max: number, maxLength = 512): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => text(item, maxLength))
        .slice(0, max)
    : [];
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A bounded projection of already-authorized index data, never a policy or document fetch. */
export function professionalContext(
  frontmatter: unknown,
): ProfessionalContext | undefined {
  const profile = record(record(frontmatter)['x-professional-oracle']);
  const observation = record(profile.observation);
  if (
    profile.version !== '1' ||
    observation.mode !== 'advisory' ||
    observation.modelAssessments !== false
  )
    return undefined;
  const scope = record(profile.serviceScope);
  if (!text(scope.summary, 2000)) return undefined;
  const methods = (Array.isArray(profile.methods) ? profile.methods : [])
    .slice(0, 64)
    .flatMap((raw) => {
      const value = record(raw);
      return text(value.id) && text(value.documentRef)
        ? [
            {
              id: value.id,
              documentRef: value.documentRef,
              resourceRefs: refs(value.resourceRefs, 64),
            },
          ]
        : [];
    });
  const rules = (
    Array.isArray(profile.rulePractices) ? profile.rulePractices : []
  )
    .slice(0, 64)
    .flatMap((raw) => {
      const value = record(raw);
      return text(value.ruleRef) &&
        text(value.documentRef) &&
        ['documented', 'manual', 'observed', 'unimplemented'].includes(
          String(value.implementationStatus),
        )
        ? [
            {
              ruleRef: value.ruleRef,
              documentRef: value.documentRef,
              implementationStatus: String(value.implementationStatus),
            },
          ]
        : [];
    });
  return {
    version: '1',
    observation: { mode: 'advisory', modelAssessments: false },
    serviceScope: {
      summary: scope.summary,
      exclusions: refs(scope.exclusions, 64, 2000),
      protocols: refs(scope.protocols, 64),
    },
    methods,
    rulePractices: rules,
  };
}

export function isProfessionalPublicationIntent(
  frontmatter: unknown,
  did: string,
): boolean {
  const front = record(frontmatter);
  const profile = record(front['x-professional-oracle']);
  const anchor = record(record(front.documents).anchoring);
  return (
    record(front.conformance).profile === 'persisted_draft' &&
    record(front.domain).type === 'oracle' &&
    professionalContext(front) !== undefined &&
    Array.isArray(profile.runtimeTargets) &&
    profile.runtimeTargets.includes('qiforge') &&
    anchor.method === 'iid_linked_resource' &&
    anchor.reference === `${did}#dom` &&
    anchor.cid === null &&
    anchor.verified_at === null
  );
}

export function observeProfessionalContext(input: {
  snapshot: DomainSnapshot;
  configuredRevision?: string;
  runId: string;
  options?: ObservationOptions;
  background?: (work: Promise<unknown>) => void;
  replay?: boolean;
}): void {
  const { snapshot, options } = input;
  if (!options || options.mode !== 'advisory' || input.replay) return;
  const profile = professionalContext(snapshot.document?.frontmatter);
  const loadedRevision =
    snapshot.status === 'verified' && snapshot.document
      ? (snapshot.anchor?.cid ?? null)
      : null;
  const readIds = new Set(snapshot.documentsRead?.map((entry) => entry.id));
  const changed = Boolean(
    input.configuredRevision &&
    loadedRevision &&
    input.configuredRevision !== loadedRevision,
  );
  const rules = profile?.rulePractices.slice(0, 16) ?? [
    {
      ruleRef: 'check:professional-context',
      documentRef: 'domain.md',
      implementationStatus: 'documented',
    },
  ];
  for (const [index, rule] of rules.entries()) {
    const read = readIds.has(rule.documentRef);
    dispatchObservation(
      {
        observationId: `${input.runId}:context:${index}:${loadedRevision ?? 'unavailable'}:${read ? 'read' : 'unread'}`,
        runId: input.runId,
        stage: 'context',
        observedAt: new Date().toISOString(),
        ruleRef: rule.ruleRef,
        governingRevision: {
          domainDid: snapshot.did,
          configuredRevision: input.configuredRevision ?? null,
          loadedRevision,
        },
        evidenceRefs:
          snapshot.documentsRead?.slice(0, 64).map((entry) => entry.cid) ?? [],
        check: { id: 'check:professional-document-context', version: '1' },
        assessment: changed
          ? 'apparent_inconsistency'
          : profile && read
            ? 'consistent'
            : 'insufficient_evidence',
        uncertainty: 'high',
        suggestedFollowUp: changed
          ? 'The loaded revision differs from the requested revision. Review the context provenance.'
          : 'This observation concerns document availability only. It does not establish compliance with the rule.',
      },
      {
        ...options,
        emit: async (observation) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              Promise.resolve().then(() => options.emit(observation)),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error('observer-timeout')),
                  1000,
                );
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
        schedule: options.schedule ?? input.background,
      },
    );
  }
}
