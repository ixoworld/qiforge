import { ActionReferenceSchema } from '@ixo/ixo-transaction/action-proposals';
import { parseReference, type ActionReferenceV1 } from '@ixo/action-protocol';
import { z } from 'zod';
import type { ReplyContent, ReplyFile, ReplyPlan } from './types';

const ArtifactRefSchema = z.object({
  artifactId: z.string(),
  title: z.string(),
  url: z.string(),
  mime: z.literal('text/markdown'),
  bytes: z.number(),
  expiresAt: z.string(),
});

function isSignedLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * The most a gateway takes (`maxFileUrlChars`): with room for its caption the
 * link must still fit one 4,096-character text message.
 */
export const REPLY_FILE_URL_MAX = 3800;

export const ReplyFileSchema = z.object({
  url: z
    .string()
    .max(REPLY_FILE_URL_MAX)
    .refine(isSignedLink, 'must be an https URL without credentials'),
  filename: z.string().min(1),
  mimetype: z.string().min(1),
  bytes: z.number().int().nonnegative().optional(),
  caption: z.string().max(1024).optional(),
  expiresAt: z.string().optional(),
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
        kind: z.literal('action'),
        action: ActionReferenceSchema,
      }),
      z.object({
        partId: z.string(),
        kind: z.literal('hub-action'),
        actionReference: z.custom<ActionReferenceV1>((value) => {
          try {
            parseReference(value);
            return true;
          } catch {
            return false;
          }
        }),
        summary: z.string().min(1).max(80),
      }),
      z.object({
        partId: z.string(),
        kind: z.literal('artifact'),
        artifact: ArtifactRefSchema,
      }),
      z.object({
        partId: z.string(),
        kind: z.literal('file'),
        file: ReplyFileSchema,
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

function fileLine(file: ReplyFile): string {
  const link = `[${linkLabel(file.filename)}](${file.url})`;
  return file.caption ? `${file.caption}\n\n${link}` : link;
}

/**
 * The plan as one Markdown message: what gateways that predate plans receive.
 * A file is a link line, so a gateway that cannot read the `file` part
 * degrades instead of losing the file. Never stored as a run's text, which
 * stays the model's own, and never shown to the model or mirrored to a room:
 * see `planTextForModel`.
 */
export function planText(plan: { parts: readonly ReplyContent[] }): string {
  return plan.parts
    .map((part) =>
      part.kind === 'text'
        ? part.text
        : part.kind === 'action'
          ? `[${linkLabel(part.action.title)}](${part.action.url})`
          : part.kind === 'hub-action'
            ? `[${linkLabel(part.summary)}](${part.actionReference.url})`
            : part.kind === 'file'
              ? fileLine(part.file)
              : `[${linkLabel(part.artifact.title)}](${part.artifact.url})`,
    )
    .join('\n\n');
}

/**
 * `planText` without a file's signed link, which is named instead: for the
 * model, as when a user quotes an earlier reply, for the room mirror, and for
 * the transcript, all of which outlive the link.
 */
export function planTextForModel(plan: {
  parts: readonly ReplyContent[];
}): string {
  return planText({
    parts: plan.parts.map(
      (part): ReplyContent =>
        part.kind === 'file'
          ? {
              kind: 'text',
              text: [part.file.caption, `[File sent: ${part.file.filename}]`]
                .filter(Boolean)
                .join('\n\n'),
            }
          : part,
    ),
  });
}
