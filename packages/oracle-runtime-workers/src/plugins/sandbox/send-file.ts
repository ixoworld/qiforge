import { ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { CHANNEL_FILENAME_MAX } from '../../channels/contract';
import { ReplyFileSchema } from '../../delivery/schema';
import type { ReplyFile } from '../../delivery/types';
import { tool } from '../../plugin-api/tool-helper';
import type { Logger, PluginTool } from '../../plugin-api/types';

export const SEND_FILE_TOOL = 'send_file';

/** The upstream tool that signs a stored file's link. */
export const PRESIGNED_URL_TOOL = 'artifact_get_presigned_url';

/** Upstream tools that return signed links next to a file's metadata. */
export const URL_RESULT_TOOLS: ReadonlySet<string> = new Set([
  'artifact_get_by_path',
  'artifact_list',
  'artifact_get_by_cid',
]);

/** Appended to those tools' descriptions on a chat surface. */
export const CHAT_URL_NOTE =
  'In this chat the URL fields are removed from the result and `artifact_get_presigned_url` does not exist: deliver a file to the user with `send_file`.';

export const SendFileArgs = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .describe(
      'The stored path of the file, for example `/output/report.docx`.',
    ),
  caption: z
    .string()
    .trim()
    .max(1024)
    .optional()
    .describe('A short line shown with the file, at most 1,024 characters.'),
});

/**
 * What `send_file` sends, by extension, with its MIME type: the types a chat
 * gateway delivers. A gateway refuses any other (the legacy `.doc`, `.xls`
 * and `.ppt` included), so the tool refuses it before signing anything.
 */
const FILE_MIME: ReadonlyMap<string, string> = new Map([
  ['pdf', 'application/pdf'],
  [
    'docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  [
    'pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  ['txt', 'text/plain'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['md', 'text/markdown'],
  ['markdown', 'text/markdown'],
  ['csv', 'text/csv'],
]);

/** The types in `FILE_MIME`, as the tool description and the prompt name them. */
export const SENDABLE_FILE_TYPES =
  'PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), text, CSV, Markdown, PNG or JPEG';

/** The MIME type of a filename `send_file` may send; `undefined` for any other. */
export function fileMimetype(filename: string): string | undefined {
  const dot = filename.lastIndexOf('.');
  const extension = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
  return FILE_MIME.get(extension);
}

/**
 * The name a file is delivered under: the path's last segment, without
 * control, format (bidi, zero-width) or filesystem-reserved characters, cut
 * to `CHANNEL_FILENAME_MAX` code points with its extension kept.
 */
export function deliveredFilename(path: string): string {
  const last = path.split(/[/\\]/).filter(Boolean).pop() ?? '';
  const clean = last
    .replace(/[\p{Cc}\p{Cf}:*?"<>|]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .trimEnd();
  const chars = Array.from(clean);
  if (chars.length === 0) return 'file';
  if (chars.length <= CHANNEL_FILENAME_MAX) return clean;
  const dot = clean.lastIndexOf('.');
  const extension = dot > 0 ? Array.from(clean.slice(dot)) : [];
  // An "extension" as long as the limit is not one worth keeping.
  const tail = extension.length < 32 ? extension : [];
  return [...chars.slice(0, CHANNEL_FILENAME_MAX - tail.length), ...tail].join(
    '',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An MCP tool's JSON result, however the adapter handed it over: the JSON
 * text, a text content block, a list of blocks, or already an object.
 * `undefined` when it holds no JSON object.
 */
function resultObject(result: unknown): Record<string, unknown> | undefined {
  if (typeof result === 'string') {
    try {
      const parsed: unknown = JSON.parse(result);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(result)) {
    for (const block of result) {
      const found = resultObject(block);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(result)) return undefined;
  return typeof result.text === 'string' ? resultObject(result.text) : result;
}

function httpsUrl(value: unknown): string | undefined {
  return typeof value === 'string' &&
    ReplyFileSchema.shape.url.safeParse(value).success
    ? value
    : undefined;
}

function isUrlValue(value: unknown): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function withoutUrls(value: unknown): unknown {
  if (Array.isArray(value))
    return value
      .filter((item) => !isUrlValue(item))
      .map((item) => withoutUrls(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      // `expiresIn` is the expiry of the links that just went.
      .filter(
        ([key, item]) =>
          !/url$/i.test(key) && key !== 'expiresIn' && !isUrlValue(item),
      )
      .map(([key, item]) => [key, withoutUrls(item)]),
  );
}

const UNREADABLE_RESULT = JSON.stringify({
  error: 'The result could not be read.',
});

function jsonWithoutUrls(text: string): string {
  try {
    return JSON.stringify(withoutUrls(JSON.parse(text)), null, 2);
  } catch {
    // Links can only be removed from a structured result, so anything else
    // never reaches the model on a chat surface.
    return UNREADABLE_RESULT;
  }
}

/**
 * An artefact lookup's result without its URLs, in the shape it came in. The
 * result is structured data, so this reads fields, not prose: a field whose
 * name ends in `url` goes, and so does any string value that is a link.
 */
export function stripArtifactUrls(result: unknown): unknown {
  if (typeof result === 'string') return jsonWithoutUrls(result);
  if (Array.isArray(result)) return result.map(stripArtifactUrls);
  if (!isRecord(result)) return result;
  const stripped = withoutUrls(result) as Record<string, unknown>;
  return typeof result.text === 'string'
    ? { ...stripped, text: jsonWithoutUrls(result.text) }
    : stripped;
}

/** The handle `send_file` signs through: the upstream presigned-URL tool. */
export interface PresignTool {
  invoke(input: unknown): Promise<unknown>;
}

const NOT_FOUND = /not found/i;

function notFoundError(path: string): string {
  return `No stored file at \`${path}\`. A file is stored once the sandbox call that wrote it under \`/workspace/data/output/\` has finished. Check the path with \`artifact_list\`, or write the file first, then call \`send_file\` again.`;
}

function unsupportedTypeError(path: string): string {
  return `Cannot send \`${path}\`. This chat can only receive ${SENDABLE_FILE_TYPES} files. Convert the file, or describe its contents instead.`;
}

function failedError(path: string): string {
  return `Could not prepare \`${path}\` for sending. Try once more; if it fails again, tell the user the file could not be sent. Do not offer a link.`;
}

/**
 * Sign the file and build what the plan delivers. Failures come back as the
 * text the model reads, and are logged by kind only: an upstream error is
 * never repeated, here or to the model, because it could quote a signed URL.
 */
async function signFile(
  presign: PresignTool,
  args: z.infer<typeof SendFileArgs>,
  logger: Pick<Logger, 'warn'>,
): Promise<{ file: ReplyFile; path: string } | { error: string }> {
  const failed = (kind: string, error: string): { error: string } => {
    logger.warn(`[send_file] ${args.path}: ${kind}`);
    return { error };
  };
  // Checked before signing: a file of another type is never signed.
  const filename = deliveredFilename(args.path);
  const mimetype = fileMimetype(filename);
  if (!mimetype)
    return failed('unsupported type', unsupportedTypeError(args.path));
  let signed: Record<string, unknown> | undefined;
  try {
    signed = resultObject(await presign.invoke({ path: args.path }));
  } catch (error) {
    return error instanceof Error && NOT_FOUND.test(error.message)
      ? failed('not found', notFoundError(args.path))
      : failed(
          `lookup failed (${error instanceof Error ? error.name : 'unknown'})`,
          failedError(args.path),
        );
  }
  if (typeof signed?.error === 'string')
    return NOT_FOUND.test(signed.error)
      ? failed('not found', notFoundError(args.path))
      : failed('lookup refused', failedError(args.path));
  const url = httpsUrl(signed?.downloadUrl) ?? httpsUrl(signed?.url);
  if (!url) return failed('no usable link returned', failedError(args.path));

  const { expiresIn, path, size } = signed ?? {};
  return {
    path: typeof path === 'string' && path ? path : args.path,
    file: {
      url,
      filename,
      mimetype,
      ...(typeof size === 'number' ? { bytes: size } : {}),
      ...(args.caption ? { caption: args.caption } : {}),
      ...(typeof expiresIn === 'number'
        ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
        : {}),
    },
  };
}

/**
 * A call's `ToolMessage.artifact`: the part's file plus `path`, the store's
 * normalised path, which identifies the file and never leaves the runtime.
 */
const SentFileSchema = ReplyFileSchema.extend({ path: z.string().min(1) });

/** What one call delivers, from its `ToolMessage.artifact`; null for none. */
export function sentFile(
  artifact: unknown,
): { path: string; file: ReplyFile } | null {
  const parsed = SentFileSchema.safeParse(artifact);
  if (!parsed.success) return null;
  const { path, ...file } = parsed.data;
  return { path, file };
}

/**
 * Bound on chat surfaces only, by the sandbox plugin. It carries the signed
 * link in `ToolMessage.artifact`, which the checkpoint keeps and the plan
 * reads, and which no chat model converter sends: the model reads the
 * content, which never holds the link. Runs again after a reset
 * (`effect: 'read'`); a new signature for the same file is fine.
 * `attachments`: whether the surface delivers a file as an attachment.
 */
export function buildSendFileTool(
  presign: PresignTool,
  attachments: boolean,
): PluginTool {
  return tool(
    async (rawArgs, ctx) => {
      const args = SendFileArgs.parse(rawArgs);
      const signed = await signFile(presign, args, ctx.logger);
      if ('error' in signed) return { ok: false, error: signed.error };
      const { filename, mimetype } = signed.file;
      const artifact = { ...signed.file, path: signed.path };
      return new ToolMessage({
        tool_call_id: ctx.toolCallId ?? '',
        name: SEND_FILE_TOOL,
        content: JSON.stringify({
          ok: true,
          filename,
          mimetype,
          delivery:
            'Attached to your reply: it goes out when the reply does. Do not paste a link.',
        }),
        artifact,
      });
    },
    {
      name: SEND_FILE_TOOL,
      description: `Send the user a file ${attachments ? 'as an attachment in this chat' : 'as a link posted in this room'}. Use it for every file meant for the user; it sends ${SENDABLE_FILE_TYPES} files only. Build the file yourself in the sandbox: do not send a file you downloaded from the internet unless the user asked for that exact file. Not for helper scripts or intermediate files. \`path\` is the stored path, for example \`/output/report.docx\`: save the file under \`/workspace/data/output/\` and let that sandbox call finish first. \`caption\` is an optional short line shown with the file. ${attachments ? 'The user receives the file itself' : 'The link is posted for you'}, so never paste a download link and do not explain how to open it. For several files, call it once per file, in the order they should arrive. If it returns an error, follow it, or tell the user the file could not be sent.`,
      schema: SendFileArgs,
      effect: 'read',
    },
  );
}
