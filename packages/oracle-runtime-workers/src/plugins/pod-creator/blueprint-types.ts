import { z } from 'zod';
import { DESIGN_POD_STAGES, type DesignPodStage } from './design-pod-roles';

/**
 * One section of the blueprint, produced by a specialist role. The `content`
 * is role-defined and opaque to the conductor — it is recorded, never parsed,
 * by the orchestration layer. Gate-bearing roles (the evaluate oracles and the
 * launch-readiness gate) additionally carry a `verdict`.
 *
 * Declared as a schema because the blueprint is stored as JSON in the user's
 * database and read back as `unknown`.
 */
export const blueprintSectionSchema = z.object({
  /** The role id that produced this section (e.g. `service_architect`). */
  role: z.string(),
  /** The lifecycle stage the section belongs to. */
  stage: z.enum(DESIGN_POD_STAGES),
  /** The section's structured content (role-defined). */
  content: z.unknown(),
  /** Gate verdict for gate-bearing roles; absent for plain sections. */
  verdict: z.enum(['pass', 'fail']).optional(),
  /** Blocking issues when `verdict` is `'fail'`. */
  blockers: z.array(z.string()).optional(),
  /** ISO-8601 timestamp when the section was recorded. */
  recordedAt: z.string(),
});

export type BlueprintSection = z.infer<typeof blueprintSectionSchema>;

/**
 * The per-thread blueprint document the conductor builds up across a design
 * session. Sections are keyed by role id (one section per specialist). Stage
 * and readiness are DERIVED from these sections — they are never stored, so the
 * document stays a single source of truth.
 */
export const podBlueprintSchema = z.object({
  /** The owning thread id (`RuntimeContext.session.id`). */
  threadId: z.string(),
  /** A concise statement of the POD's intent, set at session start. */
  brief: z.string().optional(),
  /** Recorded sections, keyed by role id. */
  sections: z.record(z.string(), blueprintSectionSchema),
  /** ISO-8601 timestamps. */
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PodBlueprint = z.infer<typeof podBlueprintSchema>;

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
