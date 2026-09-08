/**
 * Turn-time attachment handling — the port of the Node runtime's
 * `MessagesService` attachment section plus `FileProcessingService.
 * processAttachments`:
 *
 *  1. classify + route each attachment by the selected model's native input
 *     capabilities (`send-native` / `parse-local` / `model-extract`);
 *  2. NATIVE lane: download, sniff, base64 into LangChain content blocks on
 *     the human message (cumulative 50 MB budget; any failure or budget
 *     overflow falls that file back to extraction so a bad download never
 *     drops the whole message); the original is archived to the sandbox in
 *     the background;
 *  3. EXTRACT lane: sequential (so the running download total is enforced
 *     before the next fetch), plain text read locally, everything else
 *     described / transcribed / extracted by the helper model, then archived
 *     to the sandbox — when the archive succeeds the text handed to the model
 *     is truncated to 500 chars and points at the sandbox copy (the agent's
 *     file tools read the rest), exactly as on Node;
 *  4. every attachment's metadata lands on the human message so transcripts
 *     render file chips regardless of which lane consumed it.
 */
import type { MessageContent } from '@langchain/core/messages';
import type { ModelInputCapabilities } from '../core/llm';
import { bytesToBase64 } from '../plugins/base64';
import type { Logger } from '../plugin-api/types';
import type { AttachmentMeta } from '../sqlite/serialization';
import { classifyAttachment } from './classify';
import {
  buildUserMessageContent,
  type NativeAttachment,
} from './content-blocks';
import {
  ALLOWED_URI_SCHEMES,
  loadAttachmentBytes,
  MAX_FILE_SIZE,
  MAX_TOTAL_SIZE,
  type MatrixMediaSource,
} from './download';
import {
  aiProcessFromUrl,
  extractText,
  formatContent,
  type ExtractionProvider,
  type ExtractionUsage,
} from './extract';
import { categorizeFile, verifyMagicBytes, type FileCategory } from './magic';
import { routeAttachment } from './route';
import {
  buildAnalysisMarkdown,
  uploadToSandbox,
  type SandboxUploadConfig,
} from './sandbox-archive';
import {
  sanitizeAttachmentFilename,
  sanitizeSandboxPath,
  SANDBOX_OUTPUT_PREFIX,
} from './sanitize';
import type { AttachmentInput } from './types';

/** Node's `SANDBOX_TRUNCATE_LIMIT`: what the model sees inline once the file is archived. */
export const SANDBOX_TRUNCATE_LIMIT = 500;

export interface AttachmentPipelineDeps {
  source: MatrixMediaSource;
  /** Helper-model provider for the extract lane; null → media cannot be extracted here. */
  extraction: ExtractionProvider | null;
  /** Sandbox archive target; null → originals are not archived (logged once per turn). */
  sandbox: SandboxUploadConfig | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  logger: Logger;
}

export interface ExtractedAttachment {
  /** Model-facing text, prefixed with a `[source: …]` reference like Node's. */
  text: string;
  meta: AttachmentMeta;
}

export interface PreparedAttachments {
  /** The human message content: the text, plus native blocks when any. */
  content: MessageContent;
  /** Metadata for every attachment, in request order (chips in transcripts). */
  metas: AttachmentMeta[];
  /** Extraction-lane results, to append as hidden context messages. */
  extracted: ExtractedAttachment[];
  usage: { cost: number; promptTokens: number; completionTokens: number };
}

export interface PrepareAttachmentsParams {
  text: string;
  attachments: AttachmentInput[];
  /** Room for `eventId` downloads (the user↔oracle room, or the Matrix room the turn came from). */
  roomId?: string;
  /** The model the turn will run on and its native input capabilities. */
  model: string;
  caps: ModelInputCapabilities;
}

function metaFor(attachment: AttachmentInput): AttachmentMeta {
  return {
    filename: attachment.filename,
    mimetype: attachment.mimetype,
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    ...(attachment.mxcUri ? { mxcUri: attachment.mxcUri } : {}),
    ...(attachment.eventId ? { eventId: attachment.eventId } : {}),
    category: classifyAttachment(attachment),
  };
}

function sourceRef(attachment: AttachmentInput): string {
  if (attachment.eventId) return `[source: eventId="${attachment.eventId}"]`;
  if (attachment.mxcUri) return `[source: url="${attachment.mxcUri}"]`;
  return '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One attachment through the extract lane (Node's `processAttachment`). */
async function extractOne(
  attachment: AttachmentInput,
  currentTotal: number,
  params: PrepareAttachmentsParams,
  deps: AttachmentPipelineDeps,
): Promise<{ text: string; downloaded: number; usage?: ExtractionUsage }> {
  const safeName = sanitizeAttachmentFilename(attachment.filename);
  if (!attachment.eventId && !attachment.mxcUri)
    throw new Error('Either mxcUri or eventId must be provided');
  if (attachment.mxcUri && !ALLOWED_URI_SCHEMES.test(attachment.mxcUri))
    throw new Error('Invalid URI scheme');
  if (attachment.size && attachment.size > MAX_FILE_SIZE)
    throw new Error('File exceeds maximum size');
  if (attachment.size && currentTotal + attachment.size > MAX_TOTAL_SIZE)
    throw new Error('Total attachment size budget exceeded');

  const category: FileCategory = categorizeFile(attachment.mimetype);
  if (category === 'unsupported') {
    deps.logger.warn(
      `[attachments] unsupported file type ${attachment.mimetype} for ${attachment.filename}`,
    );
    return {
      text: `[File "${safeName}" (${attachment.mimetype}) is not a supported file type and could not be processed]`,
      downloaded: 0,
    };
  }

  const { bytes } = await loadAttachmentBytes(
    attachment,
    params.roomId,
    deps.source,
    { fetchImpl: deps.fetchImpl, signal: deps.signal },
  );
  verifyMagicBytes(bytes, category, attachment, (m) =>
    deps.logger.warn(`[attachments] ${m}`),
  );

  // Public http(s) images/videos: let the provider fetch the URL itself.
  const isHttpUrl =
    Boolean(attachment.mxcUri) &&
    !attachment.eventId &&
    /^https?:\/\//i.test(attachment.mxcUri ?? '');
  let text: string | undefined;
  let usage: ExtractionUsage | undefined;
  if (
    isHttpUrl &&
    deps.extraction &&
    (category === 'image' || category === 'video')
  ) {
    try {
      const passthrough = await aiProcessFromUrl(
        attachment.mxcUri!,
        category,
        deps.extraction,
        { fetchImpl: deps.fetchImpl, signal: deps.signal },
      );
      if (passthrough.content.trim().length > 0) {
        text = formatContent('Description', safeName, passthrough.content);
        usage = passthrough.usage;
      }
    } catch (error) {
      deps.logger.warn(
        `[attachments] URL passthrough failed for "${attachment.filename}", falling back to bytes: ${errorMessage(error)}`,
      );
    }
  }
  if (text === undefined) {
    const extracted = await extractText(
      bytes,
      attachment,
      category,
      deps.extraction,
      { fetchImpl: deps.fetchImpl, signal: deps.signal },
    );
    text = extracted.text;
    usage = extracted.usage;
  }

  if (!deps.sandbox) {
    return { text, downloaded: bytes.length, ...(usage ? { usage } : {}) };
  }
  const destPath = `${SANDBOX_OUTPUT_PREFIX}/${safeName}`;
  try {
    await uploadToSandbox(
      bytes,
      safeName,
      destPath,
      deps.sandbox,
      attachment.mimetype,
      deps.fetchImpl,
    );
    const actualPath = sanitizeSandboxPath(destPath);
    let analysisPath: string | undefined;
    if (category === 'image' || category === 'video' || category === 'audio') {
      const analysisFilename = `${safeName.replace(/\.[^.]+$/, '')}-analysis.md`;
      const analysisDest = `${SANDBOX_OUTPUT_PREFIX}/${analysisFilename}`;
      try {
        await uploadToSandbox(
          new TextEncoder().encode(
            buildAnalysisMarkdown(
              safeName,
              attachment.mimetype,
              bytes.length,
              category,
              text,
            ),
          ),
          analysisFilename,
          analysisDest,
          deps.sandbox,
          'text/markdown',
          deps.fetchImpl,
        );
        analysisPath = sanitizeSandboxPath(analysisDest);
      } catch (error) {
        deps.logger.warn(
          `[attachments] analysis .md upload failed for "${attachment.filename}": ${errorMessage(error)}`,
        );
      }
    }
    if (text.length > SANDBOX_TRUNCATE_LIMIT) {
      const paths = analysisPath
        ? `\n\n[Full analysis saved to sandbox at ${analysisPath}]\n[Original file saved to sandbox at ${actualPath}]`
        : `\n\n[Full file saved to sandbox at ${actualPath}]`;
      return {
        text: text.slice(0, SANDBOX_TRUNCATE_LIMIT) + paths,
        downloaded: bytes.length,
        ...(usage ? { usage } : {}),
      };
    }
    const suffix = analysisPath
      ? `\n\n[Analysis saved to sandbox at ${analysisPath}]\n[File also saved to sandbox at ${actualPath}]`
      : `\n\n[File also saved to sandbox at ${actualPath}]`;
    return {
      text: text + suffix,
      downloaded: bytes.length,
      ...(usage ? { usage } : {}),
    };
  } catch (error) {
    deps.logger.warn(
      `[attachments] sandbox upload failed for "${attachment.filename}": ${errorMessage(error)}`,
    );
    return {
      text: `${text}\n\n[Warning: sandbox upload failed — file content is included above]`,
      downloaded: bytes.length,
      ...(usage ? { usage } : {}),
    };
  }
}

export async function prepareAttachments(
  params: PrepareAttachmentsParams,
  deps: AttachmentPipelineDeps,
): Promise<PreparedAttachments> {
  const metas = params.attachments.map(metaFor);
  const usage = { cost: 0, promptTokens: 0, completionTokens: 0 };
  if (params.attachments.length === 0) {
    return { content: params.text, metas, extracted: [], usage };
  }

  const reportedTotal = params.attachments.reduce(
    (sum, a) => sum + (a.size ?? 0),
    0,
  );
  if (reportedTotal > MAX_TOTAL_SIZE) {
    throw new Error(
      `Total attachment size (${Math.round(reportedTotal / 1024 / 1024)} MB) exceeds budget (${Math.round(MAX_TOTAL_SIZE / 1024 / 1024)} MB)`,
    );
  }

  const nativeCandidates: AttachmentInput[] = [];
  const extractQueue: AttachmentInput[] = [];
  for (const attachment of params.attachments) {
    const kind = classifyAttachment(attachment);
    const strategy = routeAttachment(kind, params.caps);
    deps.logger.log(
      `[attachments] "${attachment.filename}" (${attachment.mimetype}) kind=${kind} model=${params.model} → ${strategy}`,
    );
    if (strategy === 'send-native') nativeCandidates.push(attachment);
    else extractQueue.push(attachment);
  }

  const natives: NativeAttachment[] = [];
  let nativeBytesTotal = 0;
  for (const attachment of nativeCandidates) {
    try {
      const { bytes, mimetype } = await loadAttachmentBytes(
        attachment,
        params.roomId,
        deps.source,
        { fetchImpl: deps.fetchImpl, signal: deps.signal },
      );
      if (nativeBytesTotal + bytes.length > MAX_TOTAL_SIZE) {
        deps.logger.warn(
          `[attachments] native budget (${Math.round(MAX_TOTAL_SIZE / 1024 / 1024)} MB) exceeded at "${attachment.filename}" — falling back to extraction`,
        );
        extractQueue.push(attachment);
        continue;
      }
      nativeBytesTotal += bytes.length;
      const kind = classifyAttachment({
        mimetype,
        filename: attachment.filename,
      });
      natives.push({
        kind: kind === 'image' ? 'image' : 'file',
        mimeType: mimetype,
        base64: bytesToBase64(bytes),
        filename: attachment.filename,
      });
      deps.logger.log(
        `[attachments] NATIVE → "${attachment.filename}" sent directly to ${params.model} (${bytes.length} bytes, ${kind})`,
      );
      if (deps.sandbox) {
        const safeName = sanitizeAttachmentFilename(attachment.filename);
        // Off the hot path — the agent's file tools can reach the original later.
        void uploadToSandbox(
          bytes,
          safeName,
          `${SANDBOX_OUTPUT_PREFIX}/${safeName}`,
          deps.sandbox,
          mimetype,
          deps.fetchImpl,
        ).catch((error: unknown) => {
          deps.logger.warn(
            `[attachments] background archive failed for "${attachment.filename}": ${errorMessage(error)}`,
          );
        });
      }
    } catch (error) {
      deps.logger.warn(
        `[attachments] native load failed for "${attachment.filename}", falling back to extraction: ${errorMessage(error)}`,
      );
      extractQueue.push(attachment);
    }
  }

  const extracted: ExtractedAttachment[] = [];
  if (extractQueue.length > 0) {
    deps.logger.log(
      `[attachments] EXTRACT ${extractQueue.length} attachment(s) (local parse for text, helper model otherwise)`,
    );
    if (!deps.sandbox) {
      deps.logger.warn(
        '[attachments] sandbox archive unavailable for this turn — originals are not archived',
      );
    }
    let downloadedTotal = 0;
    for (const attachment of extractQueue) {
      const meta = metaFor(attachment);
      let text: string;
      try {
        const result = await extractOne(
          attachment,
          downloadedTotal,
          params,
          deps,
        );
        downloadedTotal += result.downloaded;
        if (downloadedTotal > MAX_TOTAL_SIZE) {
          throw new Error(
            `Total downloaded size (${Math.round(downloadedTotal / 1024 / 1024)} MB) exceeds budget (${Math.round(MAX_TOTAL_SIZE / 1024 / 1024)} MB)`,
          );
        }
        if (result.usage) {
          usage.cost += result.usage.cost ?? 0;
          usage.promptTokens += result.usage.promptTokens ?? 0;
          usage.completionTokens += result.usage.completionTokens ?? 0;
        }
        text = result.text;
      } catch (error) {
        deps.logger.error(
          `[attachments] failed to process ${attachment.filename}: ${errorMessage(error)}`,
        );
        text = `[File "${sanitizeAttachmentFilename(attachment.filename)}" (${attachment.mimetype}) failed to process: ${errorMessage(error)}]`;
      }
      const ref = sourceRef(attachment);
      extracted.push({ text: ref ? `${ref}\n${text}` : text, meta });
    }
  }

  return {
    content: buildUserMessageContent(params.text, natives),
    metas,
    extracted,
    usage,
  };
}
