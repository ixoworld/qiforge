import type { DesignPodStage } from './design-pod-roles.js';

/**
 * One section of the blueprint, produced by a specialist role. The `content`
 * is role-defined and opaque to the conductor — it is recorded, never parsed,
 * by the orchestration layer. Gate-bearing roles (the evaluate oracles and the
 * launch-readiness gate) additionally carry a `verdict`.
 */
export interface BlueprintSection {
  /** The role id that produced this section (e.g. `service_architect`). */
  role: string;
  /** The lifecycle stage the section belongs to. */
  stage: DesignPodStage;
  /** The section's structured content (role-defined). */
  content: unknown;
  /** Gate verdict for gate-bearing roles; absent for plain sections. */
  verdict?: 'pass' | 'fail';
  /** Blocking issues when `verdict` is `'fail'`. */
  blockers?: string[];
  /** ISO-8601 timestamp when the section was recorded. */
  recordedAt: string;
}

/**
 * The per-thread blueprint document the conductor builds up across a design
 * session. Sections are keyed by role id (one section per specialist). Stage
 * and readiness are DERIVED from these sections — they are never stored, so the
 * document stays a single source of truth.
 */
export interface PodBlueprint {
  /** The owning thread id (`RuntimeContext.session.id`). */
  threadId: string;
  /** A concise statement of the POD's intent, set at session start. */
  brief?: string;
  /** Recorded sections, keyed by role id. */
  sections: Record<string, BlueprintSection>;
  /** ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
}

/**
 * The assembled artifact produced once the launch-readiness gate passes — the
 * `service_pod_blueprint`. The exact registry schema is refined when the
 * design-pod templates are wired; this is the structural assembly of the
 * recorded sections grouped by stage.
 */
export interface ServicePodBlueprint {
  threadId: string;
  brief?: string;
  stages: Record<DesignPodStage, BlueprintSection[]>;
  assembledAt: string;
}
