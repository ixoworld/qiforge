import { DESIGN_POD_ROLES, type DesignPodStage } from './design-pod-roles.js';
import type {
  BlueprintSection,
  PodBlueprint,
  ServicePodBlueprint,
} from './blueprint-types.js';

/** The lifecycle stages in readiness order. */
export const STAGE_ORDER: readonly DesignPodStage[] = [
  'qualify',
  'architect',
  'build',
  'evaluate',
  'package',
  'gate',
];

/** Role ids required to complete each stage, grouped from the role catalogue. */
function groupRolesByStage(): Record<DesignPodStage, string[]> {
  const out: Record<DesignPodStage, string[]> = {
    qualify: [],
    architect: [],
    build: [],
    evaluate: [],
    package: [],
    gate: [],
  };
  for (const role of DESIGN_POD_ROLES) {
    out[role.stage].push(role.id);
  }
  return out;
}

export const SPECIALISTS_FOR_STAGE: Record<DesignPodStage, readonly string[]> =
  groupRolesByStage();

/** A section counts toward readiness iff it exists and did not fail a gate. */
function sectionSatisfies(section: BlueprintSection | undefined): boolean {
  return section !== undefined && section.verdict !== 'fail';
}

/**
 * The current stage: the first stage in {@link STAGE_ORDER} whose required
 * sections are not all satisfied. A failed gate verdict leaves its stage
 * unsatisfied, so the stage re-opens until the specialist is re-run. When every
 * stage is satisfied, returns `'gate'` (and {@link computeReadiness} reports
 * `complete: true`).
 */
export function deriveStage(bp: PodBlueprint): DesignPodStage {
  for (const stage of STAGE_ORDER) {
    const allSatisfied = SPECIALISTS_FOR_STAGE[stage].every((roleId) =>
      sectionSatisfies(bp.sections[roleId]),
    );
    if (!allSatisfied) {
      return stage;
    }
  }
  return 'gate';
}

/** Readiness summary derived from the blueprint's recorded sections. */
export interface Readiness {
  /** The stage the conductor should drive next. */
  stage: DesignPodStage;
  /** True once every required section is satisfied (gate passed). */
  complete: boolean;
  /** Stages whose required sections are all satisfied. */
  completedStages: DesignPodStage[];
  /** Human-readable blockers (missing sections, failed gates). */
  blockers: string[];
  /** Fraction of required sections satisfied, `0..1`. */
  score: number;
}

export function computeReadiness(bp: PodBlueprint): Readiness {
  const blockers: string[] = [];
  const completedStages: DesignPodStage[] = [];
  let satisfied = 0;
  let required = 0;

  for (const stage of STAGE_ORDER) {
    let stageComplete = true;
    for (const roleId of SPECIALISTS_FOR_STAGE[stage]) {
      required += 1;
      const section = bp.sections[roleId];
      if (sectionSatisfies(section)) {
        satisfied += 1;
      } else {
        stageComplete = false;
        if (section === undefined) {
          blockers.push(`${stage}: ${roleId} not recorded`);
        } else {
          const detail = (section.blockers ?? []).join('; ') || 'no detail';
          blockers.push(`${stage}: ${roleId} failed (${detail})`);
        }
      }
    }
    if (stageComplete) {
      completedStages.push(stage);
    }
  }

  return {
    stage: deriveStage(bp),
    complete: required > 0 && satisfied === required,
    completedStages,
    blockers,
    score: required === 0 ? 0 : satisfied / required,
  };
}

/** Group the recorded sections by stage, preserving the stage ordering. */
function groupSectionsByStage(
  bp: PodBlueprint,
): Record<DesignPodStage, BlueprintSection[]> {
  const out: Record<DesignPodStage, BlueprintSection[]> = {
    qualify: [],
    architect: [],
    build: [],
    evaluate: [],
    package: [],
    gate: [],
  };
  for (const section of Object.values(bp.sections)) {
    out[section.stage].push(section);
  }
  return out;
}

/** Assemble the final `service_pod_blueprint` from a completed blueprint. */
export function assembleServicePodBlueprint(
  bp: PodBlueprint,
): ServicePodBlueprint {
  const blueprint: ServicePodBlueprint = {
    threadId: bp.threadId,
    stages: groupSectionsByStage(bp),
    assembledAt: new Date().toISOString(),
  };
  if (bp.brief !== undefined) {
    blueprint.brief = bp.brief;
  }
  return blueprint;
}
