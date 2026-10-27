import { describe, expect, it, vi } from 'vitest';
import {
  observeProfessionalContext,
  professionalContext,
} from './professional-observations';
import type { DomainSnapshot } from './types';
import type { ProfessionalOracleObservation } from './generated/oracle-observations';

const profile = {
  version: '1',
  observation: { mode: 'advisory', modelAssessments: false },
  serviceScope: {
    summary: 'Verify evidence.',
    exclusions: ['Legal advice'],
    protocols: ['did:ixo:entity:protocol'],
  },
  methods: [
    { id: 'method:evidence', documentRef: 'document:method', resourceRefs: [] },
  ],
  rulePractices: [
    {
      ruleRef: 'norm:source',
      documentRef: 'document:method',
      implementationStatus: 'manual',
    },
  ],
};
function snapshot(): DomainSnapshot {
  return {
    did: 'did:ixo:entity:oracle',
    status: 'verified',
    stale: false,
    findings: [],
    anchor: {
      did: 'did:ixo:entity:oracle',
      cid: 'bafk-actual',
      uri: 'https://docs.example/index',
      private: false,
      resolvedAt: 1,
      source: 'test',
    },
    document: {
      frontmatter: { 'x-professional-oracle': profile },
    } as unknown as NonNullable<DomainSnapshot['document']>,
    documentsRead: [{ id: 'document:method', cid: 'bafk-method' }],
  };
}

describe('professional context observations', () => {
  it('retains valid service exclusions longer than reference identifiers', () => {
    const exclusion = 'a'.repeat(2000);
    const source = structuredClone(profile);
    source.serviceScope.exclusions = [exclusion];
    expect(
      professionalContext({ 'x-professional-oracle': source })?.serviceScope
        .exclusions,
    ).toEqual([exclusion]);
  });

  it('projects supported references without evaluating or fetching source documents', () => {
    expect(professionalContext({ 'x-professional-oracle': profile })).toEqual(
      profile,
    );
    expect(
      professionalContext({
        'x-professional-oracle': {
          ...profile,
          observation: { mode: 'enforce' },
        },
      }),
    ).toBeUndefined();
  });

  it('records actual and configured revisions without changing the snapshot', async () => {
    const source = snapshot();
    const before = structuredClone(source);
    const emitted: ProfessionalOracleObservation[] = [];
    const work: Promise<unknown>[] = [];
    observeProfessionalContext({
      snapshot: source,
      configuredRevision: 'bafk-requested',
      runId: 'run-1',
      options: {
        mode: 'advisory',
        emit: (record) => {
          emitted.push(record);
        },
      },
      background: (promise) => {
        work.push(promise);
      },
    });
    await Promise.all(work);
    expect(source).toEqual(before);
    expect(emitted[0]).toMatchObject({
      mode: 'advisory',
      assessment: 'apparent_inconsistency',
      governingRevision: {
        configuredRevision: 'bafk-requested',
        loadedRevision: 'bafk-actual',
      },
      evidenceRefs: ['bafk-method'],
    });
  });

  it('does not mistake unread documents or unimplemented checks for a violation', async () => {
    const source = snapshot();
    source.documentsRead = [];
    const emit = vi.fn();
    const work: Promise<unknown>[] = [];
    observeProfessionalContext({
      snapshot: source,
      runId: 'run-2',
      options: { mode: 'advisory', emit },
      background: (p) => {
        work.push(p);
      },
    });
    await Promise.all(work);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ assessment: 'insufficient_evidence' }),
    );
    expect(source.status).toBe('verified');
  });

  it('disabled and replayed attempts produce no new assessments', async () => {
    const emit = vi.fn();
    observeProfessionalContext({ snapshot: snapshot(), runId: 'run-1' });
    observeProfessionalContext({
      snapshot: snapshot(),
      runId: 'run-1',
      replay: true,
      options: { mode: 'advisory', emit },
    });
    await Promise.resolve();
    expect(emit).not.toHaveBeenCalled();
  });

  it('isolates rejected sinks and fixed diagnostics without exposing source failures', async () => {
    const work: Promise<unknown>[] = [];
    const diagnostic = vi.fn();
    observeProfessionalContext({
      snapshot: snapshot(),
      runId: 'run-3',
      options: {
        mode: 'advisory',
        emit: () => {
          throw new Error('private source content');
        },
        onDiagnostic: diagnostic,
      },
      background: (p) => {
        work.push(p);
      },
    });
    await Promise.all(work);
    expect(diagnostic).toHaveBeenCalledWith('observer-failed');
  });
});
