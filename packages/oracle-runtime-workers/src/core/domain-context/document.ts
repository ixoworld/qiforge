/**
 * Reading a validated `domain.md` frontmatter: the document index entries and
 * the brief (the bounded slice of the frontmatter the prompt carries).
 */
import type { DomainDocument } from '@ixo/domain.md/workers';
import { z } from 'zod';

const documentEntry = z.object({
  id: z.string(),
  uri: z.string().nullable(),
  cid: z.string().nullable(),
  required_for_tasks: z.array(z.string()).optional(),
  freshness: z
    .object({
      last_verified: z.string().nullable(),
      max_age: z.string().nullable(),
    })
    .optional(),
  role: z.string(),
  media_type: z.string(),
  disclosure_pass: z.number(),
  sensitivity: z.string(),
  access_policy: z.string(),
  agent_use: z.object({
    read: z.boolean(),
    cite: z.boolean(),
    summarize: z.boolean(),
  }),
});
export type DomainDocumentEntry = z.infer<typeof documentEntry>;

const entriesSchema = z.object({ entries: z.array(documentEntry) });

/** The document index; empty when the frontmatter carries none (or a malformed one). */
export function entries(
  document: DomainDocument | undefined,
): DomainDocumentEntry[] {
  const result = entriesSchema.safeParse(document?.frontmatter.documents);
  return result.success ? result.data.entries : [];
}

/** `value` as a plain object, or `{}`. */
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : {};
}

/** A linked document is private unless both its access policy and its sensitivity are `public`. */
export function isPrivateEntry(entry: DomainDocumentEntry): boolean {
  return entry.access_policy !== 'public' || entry.sensitivity !== 'public';
}

/**
 * The parts of the frontmatter the model needs to orient itself: purpose and
 * boundary, constitution, sources of truth, default agent mode, controllers,
 * baseline rights, privacy, the critical don'ts and the document index
 * (without URIs or CIDs). Serialized once per CID by the resolver.
 */
export function briefBody(document: DomainDocument): Record<string, unknown> {
  const front = document.frontmatter;
  return {
    domain: front.domain,
    constitution: front.constitution,
    source_of_truth: front.source_of_truth,
    agent_default_mode: front.agent_default_mode,
    controllers: record(front.controllers).summary,
    rights: record(front.rights).agent_baseline,
    privacy: front.privacy,
    critical_do_not: front.critical_do_not,
    documents: entries(document).map((entry) => ({
      id: entry.id,
      role: entry.role,
      disclosure_pass: entry.disclosure_pass,
      required_for_tasks: entry.required_for_tasks,
      agent_use: entry.agent_use,
      access_policy: entry.access_policy,
      sensitivity: entry.sensitivity,
    })),
  };
}

/**
 * ISO 8601 durations of days and time parts (`P180D`, `PT12H`, `P1DT2H`) in
 * milliseconds; `undefined` for any other form (years, months and weeks are
 * calendar-dependent and refused).
 */
export function durationMs(value: string): number | undefined {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value,
  );
  if (!match) return undefined;
  const ms =
    (Number(match[1] ?? 0) * 86_400 +
      Number(match[2] ?? 0) * 3_600 +
      Number(match[3] ?? 0) * 60 +
      Number(match[4] ?? 0)) *
    1000;
  return ms > 0 ? ms : undefined;
}
