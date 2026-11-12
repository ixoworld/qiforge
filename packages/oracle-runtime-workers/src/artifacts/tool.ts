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
    // Room for the conclusions, decisions and next actions. It is delivered
    // as its own text part before the link (a gateway splits a text part at
    // its provider's limit, 4,096 on WhatsApp), never inside the link card.
    .max(1000)
    .describe(
      'The chat message sent before the document: the conclusions, decisions and next actions, so the user has them without opening the document. Not "here is the document".',
    ),
  followUp: z
    .string()
    .trim()
    .max(300)
    .optional()
    .describe('At most one short question, sent after the document.'),
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
      const input = {
        source: ctx.toolCallId ?? crypto.randomUUID(),
        title: args.title,
        content: args.content,
      };
      // A store failure is a result, not a thrown error: a return-direct
      // tool that throws gives the model another call, and the user would
      // then get `message` twice. The store is tried twice (it keys the
      // document on `source`, so the second attempt cannot make a second
      // one); after that the reply ends here, with the message and the
      // question and no document.
      let reason = '';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return { ok: true, ...(await create(input)) };
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
        }
      }
      ctx.logger.warn(
        `create_artifact could not store the document: ${reason}`,
      );
      return { ok: false, error: 'The document could not be stored.' };
    },
    {
      name: CREATE_ARTIFACT_TOOL,
      description:
        'Send the user a document, with a short chat message, ONLY when they asked for a document with no particular file format (or for any file, when `send_file` is not available), or when the output is genuinely document-length (a long report, long code, several screens of text). Ordinary answers, comparisons, short plans and lists stay in chat as messages: many users read chat on a data plan with no browser. Put the full Markdown in `content`; put the conclusions, decisions and next actions in `message`, so the user has them without opening the document; at most one question in `followUp`. Call it last and on its own: the reply ends after it, and the user receives the message, the document, then the question. A file in a particular format (Word, PDF, a spreadsheet, an image) is built in the sandbox and goes through `send_file` when that tool is available.',
      schema: CreateArtifactArgs,
      effect: 'read',
    },
  );
}
