import { z } from 'zod';
import { tool } from '../plugin-api/tool-helper';
import type { PluginTool } from '../plugin-api/types';
import type { ArtifactRef, ReplyContent } from '../delivery/types';

export const CREATE_ARTIFACT_TOOL = 'create_artifact';

export const CreateArtifactArgs = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe('A short title for the document, shown on the link card.'),
  content: z
    .string()
    .min(1)
    .max(200_000)
    .describe('The full document in Markdown.'),
  message: z
    .string()
    .trim()
    .min(1)
    .max(600)
    .describe(
      'One or two short sentences sent as the chat message before the link: the answer or the gist, not "here is the document".',
    ),
  followUp: z
    .string()
    .trim()
    .max(300)
    .optional()
    .describe('At most one short question, sent after the link.'),
});

/** What the tool returns; the Reply Plan reads it back off the ToolMessage. */
export const CreateArtifactResult = z.object({
  ok: z.literal(true),
  artifactId: z.string(),
  title: z.string(),
  url: z.string(),
  mime: z.literal('text/markdown'),
  bytes: z.number(),
  expiresAt: z.string(),
});

function resultRef(raw: string | undefined): ArtifactRef | null {
  if (!raw) return null;
  try {
    const parsed = CreateArtifactResult.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const { artifactId, title, url, mime, bytes, expiresAt } = parsed.data;
    return { artifactId, title, url, mime, bytes, expiresAt };
  } catch {
    return null;
  }
}

/** What one call delivered, from its arguments and its (JSON) result. */
export function createArtifactParts(
  args: unknown,
  result: string | undefined,
): ReplyContent[] {
  const parsed = CreateArtifactArgs.safeParse(args);
  const ref = resultRef(result);
  const parts: ReplyContent[] = [];
  if (parsed.success) parts.push({ kind: 'text', text: parsed.data.message });
  if (ref) parts.push({ kind: 'artifact', artifact: ref });
  if (parsed.success && parsed.data.followUp)
    parts.push({ kind: 'text', text: parsed.data.followUp });
  return parts;
}

/**
 * Bound on chat surfaces only. Idempotent per tool call id, so a run resumed
 * after a reset may run it again (`effect: 'read'`) and gets the same link.
 */
export function buildCreateArtifactTool(
  create: (input: {
    source: string;
    title: string;
    content: string;
  }) => Promise<ArtifactRef>,
): PluginTool {
  return tool(
    async (rawArgs, ctx) => {
      const args = CreateArtifactArgs.parse(rawArgs);
      const ref = await create({
        source: ctx.toolCallId ?? crypto.randomUUID(),
        title: args.title,
        content: args.content,
      });
      return { ok: true, ...ref };
    },
    {
      name: CREATE_ARTIFACT_TOOL,
      description:
        'Send the user a document they open in their browser, together with a short chat message. Use it for anything too long or too structured for chat: a plan, report, comparison, table, draft, list of more than a few items, or code. Put the full Markdown in `content`, the answer or gist in `message`, and at most one question in `followUp`. Call it last and on its own: the reply ends after it, and the user receives the message, the link, then the question.',
      schema: CreateArtifactArgs,
      effect: 'read',
    },
  );
}
