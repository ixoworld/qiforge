import { describe, expect, it } from 'vitest';
import type { BlueprintSection, PodBlueprint } from './blueprint-types.js';
import { DESIGN_POD_ROLES } from './design-pod-roles.js';
import {
  SPECIALISTS_FOR_STAGE,
  STAGE_ORDER,
  assembleServicePodBlueprint,
  computeReadiness,
  deriveStage,
} from './stage.js';

const STAGE_OF = new Map(DESIGN_POD_ROLES.map((r) => [r.id, r.stage] as const));

function section(
  role: string,
  extra: Partial<
    Pick<BlueprintSection, 'verdict' | 'blockers' | 'content'>
  > = {},
): BlueprintSection {
  const stage = STAGE_OF.get(role);
  if (!stage) {
    throw new Error(`unknown role ${role}`);
  }
  return {
    role,
    stage,
    content: extra.content ?? { ok: true },
    recordedAt: '2026-06-12T00:00:00.000Z',
    ...(extra.verdict !== undefined ? { verdict: extra.verdict } : {}),
    ...(extra.blockers !== undefined ? { blockers: extra.blockers } : {}),
  };
}

function blueprint(sections: BlueprintSection[]): PodBlueprint {
  const byRole: Record<string, BlueprintSection> = {};
  for (const s of sections) {
    byRole[s.role] = s;
  }
  return {
    threadId: 'thread-1',
    brief: 'test',
    sections: byRole,
    createdAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z',
  };
}

/** Every role for each stage up to and including `upTo`, all passing. */
function sectionsThrough(upTo: string): BlueprintSection[] {
  const out: BlueprintSection[] = [];
  for (const stage of STAGE_ORDER) {
    for (const role of SPECIALISTS_FOR_STAGE[stage]) {
      out.push(section(role, { verdict: 'pass' }));
    }
    if (stage === upTo) {
      break;
    }
  }
  return out;
}

describe('deriveStage', () => {
  it('starts at qualify for an empty blueprint', () => {
    expect(deriveStage(blueprint([]))).toBe('qualify');
  });

  it('advances as each stage is completed', () => {
    expect(deriveStage(blueprint(sectionsThrough('qualify')))).toBe(
      'architect',
    );
    expect(deriveStage(blueprint(sectionsThrough('architect')))).toBe('build');
    expect(deriveStage(blueprint(sectionsThrough('build')))).toBe('evaluate');
    expect(deriveStage(blueprint(sectionsThrough('evaluate')))).toBe('package');
    expect(deriveStage(blueprint(sectionsThrough('package')))).toBe('gate');
  });

  it('returns gate once every stage is complete', () => {
    expect(deriveStage(blueprint(sectionsThrough('gate')))).toBe('gate');
  });

  it('re-opens the earlier stage when a gate verdict fails', () => {
    const sections = sectionsThrough('gate');
    const idx = sections.findIndex((s) => s.role === 'governance_risk_oracle');
    sections[idx] = section('governance_risk_oracle', {
      verdict: 'fail',
      blockers: ['too risky'],
    });
    expect(deriveStage(blueprint(sections))).toBe('evaluate');
  });
});

describe('computeReadiness', () => {
  it('is complete with score 1 and no blockers when all sections pass', () => {
    const r = computeReadiness(blueprint(sectionsThrough('gate')));
    expect(r.complete).toBe(true);
    expect(r.score).toBe(1);
    expect(r.blockers).toEqual([]);
    expect(r.completedStages).toEqual([...STAGE_ORDER]);
  });

  it('lists missing sections as blockers and scores the fraction done', () => {
    const r = computeReadiness(blueprint(sectionsThrough('qualify')));
    expect(r.complete).toBe(false);
    expect(r.stage).toBe('architect');
    expect(r.blockers.some((b) => b.includes('service_architect'))).toBe(true);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });

  it('surfaces a failed gate with its blocker detail', () => {
    const sections = sectionsThrough('gate');
    const idx = sections.findIndex(
      (s) => s.role === 'qa_launch_readiness_oracle',
    );
    sections[idx] = section('qa_launch_readiness_oracle', {
      verdict: 'fail',
      blockers: ['missing demo'],
    });
    const r = computeReadiness(blueprint(sections));
    expect(r.complete).toBe(false);
    expect(r.blockers.some((b) => b.includes('missing demo'))).toBe(true);
  });

  it('does not satisfy a gate role recorded without a pass verdict', () => {
    const sections = sectionsThrough('gate').filter(
      (s) => s.role !== 'qa_launch_readiness_oracle',
    );
    sections.push(section('qa_launch_readiness_oracle'));
    const r = computeReadiness(blueprint(sections));
    expect(r.complete).toBe(false);
    expect(r.stage).toBe('gate');
    expect(
      r.blockers.some((b) => b.includes('qa_launch_readiness_oracle')),
    ).toBe(true);
  });
});

describe('assembleServicePodBlueprint', () => {
  it('groups recorded sections by stage', () => {
    const assembled = assembleServicePodBlueprint(
      blueprint(sectionsThrough('gate')),
    );
    expect(assembled.threadId).toBe('thread-1');
    expect(assembled.stages.architect.map((s) => s.role).sort()).toEqual(
      [...SPECIALISTS_FOR_STAGE.architect].sort(),
    );
    expect(assembled.stages.gate).toHaveLength(1);
  });
});
