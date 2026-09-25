import { z } from 'zod';
import type { ReplyContent, ReplyPlan } from './types';

const ArtifactRefSchema = z.object({
  artifactId: z.string(),
  title: z.string(),
  url: z.string(),
  mime: z.literal('text/markdown'),
  bytes: z.number(),
  expiresAt: z.string(),
});

export const ReplyPlanSchema = z.object({
  v: z.literal(1),
  parts: z.array(
    z.discriminatedUnion('kind', [
      z.object({
        partId: z.string(),
        kind: z.literal('text'),
        text: z.string(),
      }),
      z.object({
        partId: z.string(),
        kind: z.literal('artifact'),
        artifact: ArtifactRefSchema,
      }),
    ]),
  ),
});

/** A stored or transported plan, or null when it is absent or malformed. */
export function parseReplyPlan(
  json: string | null | undefined,
): ReplyPlan | null {
  if (!json) return null;
  try {
    const parsed = ReplyPlanSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function linkLabel(title: string): string {
  return title.replace(/[[\]]/g, '');
}

/**
 * The plan as one Markdown message: what the canonical transcript, the
 * Companion room mirror and gateways that predate plans receive.
 */
export function planText(plan: { parts: readonly ReplyContent[] }): string {
  return plan.parts
    .map((part) =>
      part.kind === 'text'
        ? part.text
        : `[${linkLabel(part.artifact.title)}](${part.artifact.url})`,
    )
    .join('\n\n');
}
