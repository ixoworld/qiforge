import { loadFileFromBuffer } from '@ixo/common';
import { MatrixManager } from '@ixo/matrix';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UcanService } from '../ucan/ucan.service.js';
import { type AttachmentDto } from './dto/send-message.dto.js';
import {
  FILE_PROCESSING_CREDIT_SINK,
  type FileProcessingCreditSink,
} from './file-processing-credit-sink.port.js';

interface AiProcessUsage {
  cost?: number;
  promptTokens?: number;
  completionTokens?: number;
}

interface AiProcessResult {
  content: string;
  usage?: AiProcessUsage;
}

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB per file
const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50MB total across all attachments
const MAX_TEXT_LENGTH = 50_000;
const MATRIX_DOWNLOAD_TIMEOUT_MS = 60_000;
const AI_PROCESS_TIMEOUT_MS = 120_000;
const MAX_ERROR_BODY_LENGTH = 1024;

const SANDBOX_TRUNCATE_LIMIT = 500;
const SANDBOX_OUTPUT_PREFIX = '/workspace/output';

const ALLOWED_URI_SCHEMES = /^(mxc|https?):\/\//i;
const MAX_REDIRECT_COUNT = 5;

/**
 * Block list for SSRF protection — prevents redirects to internal/cloud
 * metadata endpoints.
 */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/, // AWS/cloud metadata
  /^0\.0\.0\.0$/,
  /^\[::1?\]$/, // IPv6 loopback (bracketed)
  /^\[::ffff:[^\]]+\]$/i, // IPv4-mapped IPv6 (e.g. [::ffff:127.0.0.1])
  /^\[f[cd][0-9a-f]{2}:.*\]$/i, // IPv6 unique-local (fc00::/7) — RFC 4193
  /^\[fe[89ab][0-9a-f]:.*\]$/i, // IPv6 link-local (fe80::/10)
  /^metadata\.google\.internal$/i,
];

/**
 * Magic byte signatures for common file types.
 */
const MAGIC_BYTES: Array<{
  bytes: number[];
  offset?: number;
  mime: string;
}> = [
  // Images
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' },
  { bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' }, // RIFF (WebP container)
  { bytes: [0x42, 0x4d], mime: 'image/bmp' }, // BMP
  { bytes: [0x49, 0x49, 0x2a, 0x00], mime: 'image/tiff' }, // TIFF little-endian
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], mime: 'image/tiff' }, // TIFF big-endian
  // Documents
  { bytes: [0x25, 0x50, 0x44, 0x46], mime: 'application/pdf' },
  { bytes: [0x50, 0x4b, 0x03, 0x04], mime: 'application/zip' }, // ZIP (docx, xlsx, etc.)
  { bytes: [0xd0, 0xcf, 0x11, 0xe0], mime: 'application/msword' }, // OLE2 (doc, xls, ppt)
  // Audio
  { bytes: [0x49, 0x44, 0x33], mime: 'audio/mpeg' }, // ID3 tag (MP3)
  { bytes: [0xff, 0xfb], mime: 'audio/mpeg' }, // MP3 frame sync
  { bytes: [0xff, 0xf3], mime: 'audio/mpeg' }, // MP3 frame sync
  { bytes: [0x4f, 0x67, 0x67, 0x53], mime: 'audio/ogg' }, // OGG
  { bytes: [0x66, 0x4c, 0x61, 0x43], mime: 'audio/flac' }, // fLaC
  // Video
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], mime: 'video/webm' }, // WebM/MKV (EBML)
  { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4, mime: 'video/mp4' }, // MP4/MOV `ftyp` box at offset 4
];

const MAGIC_MIME_CATEGORIES: Record<string, FileCategory[]> = {
  'image/png': ['image'],
  'image/jpeg': ['image'],
  'image/gif': ['image'],
  'image/webp': ['image'],
  'image/bmp': ['image'],
  'image/tiff': ['image'],
  'application/pdf': ['document'],
  'application/zip': ['document'],
  'application/msword': ['document'],
  'audio/mpeg': ['audio'],
  'audio/ogg': ['audio'],
  'audio/flac': ['audio'],
  'video/webm': ['video', 'audio'],
  'video/mp4': ['video', 'audio'],
};

export type FileCategory =
  | 'document'
  | 'image'
  | 'audio'
  | 'video'
  | 'unsupported';

export interface ProcessedAttachment {
  filename: string;
  mimetype: string;
  size?: number;
  mxcUri?: string;
  eventId?: string;
  category: Exclude<FileCategory, 'unsupported'>;
  sandboxPath?: string;
}

export interface SandboxUploadConfig {
  /** Base URL of the sandbox MCP server. The `/artifacts/upload` endpoint
   *  shares the same host — only the `/mcp` suffix is stripped. */
  sandboxMcpUrl: string;
  /**
   * Auth headers minted by the caller. Must match the same scheme the
   * sandbox plugin uses for MCP tool calls — `Authorization: Bearer <ucan>`
   * plus `X-Auth-Type: ucan`, optionally followed by `x-os-*` / `x-us-*`
   * secret headers. See `plugins/sandbox/sandbox-mcp.ts`
   * (`createDefaultAuthBuilder`). Forwarded to the upload endpoint verbatim.
   */
  authHeaders: Record<string, string>;
}

/**
 * Provider configuration for the vision/file-processing model.
 * The runtime supplies these at construction time.
 */
export interface FileProcessingProviderConfig {
  apiKey: string;
  baseURL: string;
  headers: Record<string, string>;
  model: string;
}

const PROMPTS: Record<Exclude<FileCategory, 'unsupported'>, string> = {
  document: 'Extract all text content from this document verbatim.',
  image:
    'Describe this image in detail. Include all text, numbers, labels, and visual elements.',
  audio: 'Transcribe this audio completely. Include all spoken words.',
  video:
    'Describe this video in detail. Include actions, text overlays, and spoken content.',
};

/**
 * Provider config getter. Forks supply this at module composition time;
 * the default throws so a missing wiring is caught at the first attachment.
 */
let providerConfigGetter: () => FileProcessingProviderConfig = () => {
  throw new Error(
    'FileProcessingService provider config not initialised — call setFileProcessingProvider() at boot',
  );
};

export function setFileProcessingProvider(
  getter: () => FileProcessingProviderConfig,
): void {
  providerConfigGetter = getter;
}

@Injectable()
export class FileProcessingService {
  private readonly logger = new Logger(FileProcessingService.name);
  private readonly providerApiKey: string;
  private readonly providerBaseURL: string;
  private readonly providerHeaders: Record<string, string>;
  private readonly processingModel: string;

  constructor(
    private readonly config: ConfigService,
    private readonly ucanService: UcanService,
    @Optional()
    @Inject(FILE_PROCESSING_CREDIT_SINK)
    private readonly creditSink?: FileProcessingCreditSink,
  ) {
    const providerCfg = providerConfigGetter();
    this.providerApiKey = providerCfg.apiKey;
    this.providerBaseURL = providerCfg.baseURL.replace(/\/+$/, '');
    this.providerHeaders = providerCfg.headers;
    this.processingModel = providerCfg.model;
  }

  /**
   * Build the sandbox upload config for the current user. Sandbox archival
   * is mandatory — every accepted attachment is uploaded so the agent can
   * keep working with the original file. Throws when the sandbox is
   * unreachable: `SANDBOX_MCP_URL` unset, the user has no cached UCAN
   * delegation, or the oracle has no signing key.
   *
   * Auth header shape matches `plugins/sandbox/sandbox-mcp.ts`
   * (`createDefaultAuthBuilder`) exactly — same `Authorization: Bearer <ucan>`
   * + `X-Auth-Type: ucan` the sandbox MCP client sends for tool calls.
   */
  private async buildSandboxConfig(
    userDid: string,
  ): Promise<SandboxUploadConfig> {
    const sandboxMcpUrl = this.config.getOrThrow<string>('SANDBOX_MCP_URL');

    const invocation = await this.ucanService.createServiceInvocation(
      sandboxMcpUrl,
      userDid,
      'ixo:sandbox',
    );
    if (!invocation) {
      this.logger.warn(
        `[FileProcessing] Cannot archive attachments for ${userDid} — UCAN invocation unavailable`,
      );
      throw new Error(
        'Cannot process attachments — sandbox UCAN invocation unavailable',
      );
    }

    return {
      sandboxMcpUrl,
      authHeaders: {
        Authorization: `Bearer ${invocation}`,
        'X-Auth-Type': 'ucan',
      },
    };
  }

  /**
   * Sanitize a filename/path for the sandbox upload endpoint.
   * Only alphanumeric, dots, dashes, underscores, and slashes are allowed,
   * and `..` path segments are removed so the sandbox can't be escaped.
   */
  private sanitizeSandboxPath(p: string): string {
    const charset = p.replace(/[^a-zA-Z0-9._\-/]/g, '_');
    // Strip any `..` segment surrounded by `/` or string boundaries — a
    // payload like `/workspace/../etc` reduces to `/workspace/etc`.
    return charset
      .split('/')
      .filter((seg) => seg !== '..')
      .join('/');
  }

  async uploadToSandbox(
    buffer: Buffer,
    filename: string,
    destPath: string,
    sandboxConfig: SandboxUploadConfig,
    mimetype?: string,
  ): Promise<{ path: string; url?: string; previewUrl?: string }> {
    const baseUrl = sandboxConfig.sandboxMcpUrl.replace(/\/mcp\/?$/, '');
    const uploadUrl = `${baseUrl}/artifacts/upload`;

    const resolvedMime =
      mimetype ??
      this.guessMimeFromFilename(filename) ??
      'application/octet-stream';

    const safeFilename = this.sanitizeSandboxPath(filename);
    const safePath = this.sanitizeSandboxPath(destPath);

    const formData = new FormData();
    const file = new File([new Uint8Array(buffer)], safeFilename, {
      type: resolvedMime,
    });
    formData.set('file', file);
    formData.set('path', safePath);

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: { ...sandboxConfig.authHeaders },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Sandbox upload failed (${response.status}): ${errorText.slice(0, MAX_ERROR_BODY_LENGTH)}`,
      );
    }

    const result = (await response.json()) as {
      cid?: string;
      path: string;
      url?: string;
      previewUrl?: string;
    };

    return {
      path: result.path,
      url: result.url,
      previewUrl: result.previewUrl,
    };
  }

  async processAttachments(
    attachments: AttachmentDto[],
    roomId: string,
    userDid: string,
  ): Promise<{
    texts: string[];
    metadata: ProcessedAttachment[];
    totalUsage: {
      cost: number;
      promptTokens: number;
      completionTokens: number;
    };
  }> {
    this.logger.log(
      `Processing ${attachments.length} attachment(s) in room ${roomId}`,
    );

    const reportedTotal = attachments.reduce(
      (sum, a) => sum + (a.size ?? 0),
      0,
    );
    if (reportedTotal > MAX_TOTAL_SIZE) {
      throw new Error(
        `Total attachment size (${Math.round(reportedTotal / 1024 / 1024)} MB) exceeds budget (${Math.round(MAX_TOTAL_SIZE / 1024 / 1024)} MB)`,
      );
    }

    // Mint the sandbox UCAN once per request — the cached invocation is reused
    // for every attachment so we don't re-resolve did:web or re-sign per file.
    const sandboxConfig = await this.buildSandboxConfig(userDid);
    this.logger.log(
      `[FileProcessing] Sandbox archival enabled for this request → ${sandboxConfig.sandboxMcpUrl}`,
    );

    // Process sequentially so the running download total is enforced *before*
    // the next attachment is fetched. Parallel `Promise.all` would let N
    // attachments each download up to MAX_FILE_SIZE before any cumulative
    // check fired, blowing past MAX_TOTAL_SIZE by a factor of N in the worst
    // case.
    const results: Array<{
      text: string | null;
      downloadedSize: number;
      usage?: AiProcessUsage;
      metadata: ProcessedAttachment | null;
    }> = [];
    let totalDownloaded = 0;
    for (const attachment of attachments) {
      this.logger.log(
        `Attachment: "${attachment.filename}" (${attachment.mimetype}, ${attachment.size ?? 'unknown'} bytes) — source: ${attachment.eventId ? `eventId=${attachment.eventId}` : `mxcUri=${attachment.mxcUri}`}`,
      );
      try {
        const { text, downloadedSize, sandboxPath, usage } =
          await this.processAttachment(
            attachment,
            totalDownloaded,
            roomId,
            sandboxConfig,
          );
        totalDownloaded += downloadedSize;
        if (totalDownloaded > MAX_TOTAL_SIZE) {
          throw new Error(
            `Total downloaded size (${Math.round(totalDownloaded / 1024 / 1024)} MB) exceeds budget (${Math.round(MAX_TOTAL_SIZE / 1024 / 1024)} MB)`,
          );
        }
        this.logger.log(
          `Attachment "${attachment.filename}" processed — downloaded ${downloadedSize} bytes, text extracted: ${text ? text.length + ' chars' : 'none'}`,
        );
        const category = this.categorizeFile(attachment.mimetype);
        results.push({
          text,
          downloadedSize,
          usage,
          metadata: text
            ? {
                filename: attachment.filename,
                mimetype: attachment.mimetype,
                size: attachment.size,
                mxcUri: attachment.mxcUri,
                eventId: attachment.eventId,
                category:
                  category === 'unsupported' ? ('document' as const) : category,
                sandboxPath,
              }
            : null,
        });
      } catch (error) {
        this.logger.error(
          `Failed to process attachment ${attachment.filename}: ${error instanceof Error ? error.message : String(error)}`,
        );
        const errorText = `[File "${this.sanitizeFilename(attachment.filename)}" (${attachment.mimetype}) failed to process: ${error instanceof Error ? error.message : 'unknown error'}. Let the user know this file could not be read.]`;
        const category = this.categorizeFile(attachment.mimetype);
        results.push({
          text: errorText,
          downloadedSize: 0,
          metadata: {
            filename: attachment.filename,
            mimetype: attachment.mimetype,
            size: attachment.size,
            mxcUri: attachment.mxcUri,
            eventId: attachment.eventId,
            category:
              category === 'unsupported' ? ('document' as const) : category,
          },
        });
      }
    }

    const texts: string[] = [];
    const metadata: ProcessedAttachment[] = [];
    const totalUsage = { cost: 0, promptTokens: 0, completionTokens: 0 };
    for (const result of results) {
      if (result.text) {
        texts.push(result.text);
      }
      if (result.metadata) {
        metadata.push(result.metadata);
      }
      if (result.usage) {
        totalUsage.cost += result.usage.cost ?? 0;
        totalUsage.promptTokens += result.usage.promptTokens ?? 0;
        totalUsage.completionTokens += result.usage.completionTokens ?? 0;
      }
    }

    const aiCallsMade = results.filter((r) => r.usage).length;
    this.logger.log(
      `Attachments done — ${texts.length} text result(s), ${aiCallsMade} AI call(s), total downloaded: ${totalDownloaded} bytes, usage: cost=$${totalUsage.cost} tokens=${totalUsage.promptTokens + totalUsage.completionTokens}`,
    );

    if (this.creditSink && userDid && aiCallsMade > 0) {
      try {
        await this.creditSink.deductForFileProcessing(userDid, totalUsage);
      } catch (error) {
        // Non-blocking: the file was already processed; surface and continue.
        this.logger.warn(
          `[FileProcessing] Credit deduction failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { texts, metadata, totalUsage };
  }

  /**
   * Download an attachment's raw bytes for the NATIVE path — the selected model
   * receives the file/image directly, so there is no AI extraction here.
   * Sandbox archival still happens, but off the hot path via
   * `archiveAttachmentInBackground`. Reuses the same Matrix-decrypt /
   * SSRF-guarded download and magic-byte verification as `processAttachment`,
   * so the security checks are identical; only the post-download processing is
   * skipped.
   */
  async loadAttachmentBytes(
    attachment: AttachmentDto,
    roomId: string,
  ): Promise<{ buffer: Buffer; mimetype: string }> {
    if (!attachment.eventId && !attachment.mxcUri) {
      throw new Error('Either mxcUri or eventId must be provided');
    }
    if (attachment.mxcUri && !ALLOWED_URI_SCHEMES.test(attachment.mxcUri)) {
      throw new Error('Invalid URI scheme');
    }
    if (attachment.size && attachment.size > MAX_FILE_SIZE) {
      throw new Error('File exceeds maximum size');
    }

    let buffer: Buffer;
    if (attachment.eventId) {
      buffer = await this.downloadFromMatrixEvent(roomId, attachment.eventId);
    } else if (attachment.mxcUri!.startsWith('mxc://')) {
      buffer = await this.downloadFromMatrix(attachment.mxcUri!);
    } else {
      const result = await this.downloadFromUrl(attachment.mxcUri!);
      buffer = result.data;
    }

    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error('File exceeds maximum size');
    }

    this.verifyMagicBytes(
      buffer,
      this.categorizeFile(attachment.mimetype),
      attachment,
    );

    return { buffer, mimetype: attachment.mimetype };
  }

  /**
   * Fire-and-forget sandbox archival for natively-sent attachments. The
   * native path hands the raw bytes straight to the model, but the sandbox
   * copy must still exist so later file-processing (sandbox tools, scripts)
   * can reach the original. Deliberately not awaited on the request path and
   * never throws — an archive failure only logs; same destination convention
   * as `processAttachment` (`/workspace/output/<sanitized-filename>`).
   */
  archiveAttachmentInBackground(
    attachment: AttachmentDto,
    buffer: Buffer,
    userDid: string,
  ): void {
    void (async () => {
      try {
        const sandboxConfig = await this.buildSandboxConfig(userDid);
        const safeName = this.sanitizeFilename(attachment.filename);
        const destPath = `${SANDBOX_OUTPUT_PREFIX}/${safeName}`;
        await this.uploadToSandbox(
          buffer,
          safeName,
          destPath,
          sandboxConfig,
          attachment.mimetype,
        );
        this.logger.log(
          `[attachments] background sandbox archive OK — "${attachment.filename}" at ${this.sanitizeSandboxPath(destPath)}`,
        );
      } catch (error) {
        this.logger.warn(
          `[attachments] background sandbox archive failed for "${attachment.filename}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    })();
  }

  private async processAttachment(
    attachment: AttachmentDto,
    currentTotalSize: number,
    roomId: string,
    sandboxConfig: SandboxUploadConfig,
  ): Promise<{
    text: string | null;
    downloadedSize: number;
    sandboxPath?: string;
    usage?: AiProcessUsage;
  }> {
    if (!attachment.eventId && !attachment.mxcUri) {
      throw new Error('Either mxcUri or eventId must be provided');
    }

    if (attachment.mxcUri && !ALLOWED_URI_SCHEMES.test(attachment.mxcUri)) {
      throw new Error('Invalid URI scheme');
    }

    if (attachment.size && attachment.size > MAX_FILE_SIZE) {
      throw new Error('File exceeds maximum size');
    }

    if (
      attachment.size &&
      currentTotalSize + attachment.size > MAX_TOTAL_SIZE
    ) {
      throw new Error('Total attachment size budget exceeded');
    }

    const category = this.categorizeFile(attachment.mimetype);
    if (category === 'unsupported') {
      this.logger.warn(
        `Unsupported file type: ${attachment.mimetype} for ${attachment.filename}`,
      );
      return {
        text: `[File "${this.sanitizeFilename(attachment.filename)}" (${attachment.mimetype}) is not a supported file type and could not be processed. Let the user know this file type is not supported.]`,
        downloadedSize: 0,
      };
    }

    // Every accepted attachment is downloaded so the original bytes can be
    // archived to the sandbox below — the agent works with the file from
    // there, not just the extracted text.
    let buffer: Buffer;
    if (attachment.eventId) {
      buffer = await this.downloadFromMatrixEvent(roomId, attachment.eventId);
    } else if (attachment.mxcUri!.startsWith('mxc://')) {
      buffer = await this.downloadFromMatrix(attachment.mxcUri!);
    } else {
      const result = await this.downloadFromUrl(attachment.mxcUri!);
      buffer = result.data;
    }

    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error('File exceeds maximum size');
    }

    this.verifyMagicBytes(buffer, category, attachment);

    // For HTTP image/video URLs, prefer AI URL passthrough for extraction —
    // the provider fetches the URL itself instead of receiving a base64
    // re-upload. The downloaded buffer is still archived to the sandbox.
    const isHttpUrl =
      attachment.mxcUri &&
      !attachment.eventId &&
      /^https?:\/\//i.test(attachment.mxcUri);

    let text: string | undefined;
    let usage: AiProcessUsage | undefined;
    if (isHttpUrl && (category === 'image' || category === 'video')) {
      try {
        const passthrough = await this.aiProcessFromUrl(
          attachment.mxcUri!,
          attachment.mimetype,
          category,
          attachment.filename,
        );
        if (passthrough.content && passthrough.content.trim().length > 0) {
          text = this.formatContent(
            'Description',
            this.sanitizeFilename(attachment.filename),
            passthrough.content,
          );
          usage = passthrough.usage;
        }
      } catch (error) {
        this.logger.warn(
          `URL passthrough failed for "${attachment.filename}", falling back to buffer processing: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (text === undefined) {
      switch (category) {
        case 'document':
          ({ text, usage } = await this.processDocument(buffer, attachment));
          break;
        case 'image':
          ({ text, usage } = await this.processImage(buffer, attachment));
          break;
        case 'audio':
          ({ text, usage } = await this.processAudio(buffer, attachment));
          break;
        case 'video':
          ({ text, usage } = await this.processVideo(buffer, attachment));
          break;
      }
    }

    const safeName = this.sanitizeFilename(attachment.filename);
    const destPath = `${SANDBOX_OUTPUT_PREFIX}/${safeName}`;
    try {
      await this.uploadToSandbox(
        buffer,
        safeName,
        destPath,
        sandboxConfig,
        attachment.mimetype,
      );
      const actualPath = this.sanitizeSandboxPath(destPath);

      this.logger.log(
        `Attachment "${attachment.filename}" uploaded to sandbox at ${actualPath}`,
      );

      // For AI-processed files (image/video/audio), save analysis as .md
      let analysisPath: string | undefined;
      if (
        category === 'image' ||
        category === 'video' ||
        category === 'audio'
      ) {
        const analysisContent = this.buildAnalysisMarkdown(
          safeName,
          attachment.mimetype,
          buffer.length,
          category,
          text,
        );
        const analysisBuf = Buffer.from(analysisContent, 'utf-8');
        const analysisFilename = `${safeName.replace(/\.[^.]+$/, '')}-analysis.md`;
        const analysisDestPath = `${SANDBOX_OUTPUT_PREFIX}/${analysisFilename}`;
        try {
          await this.uploadToSandbox(
            analysisBuf,
            analysisFilename,
            analysisDestPath,
            sandboxConfig,
            'text/markdown',
          );
          analysisPath = this.sanitizeSandboxPath(analysisDestPath);
          this.logger.log(
            `Analysis for "${attachment.filename}" saved to sandbox at ${analysisPath}`,
          );
        } catch (error) {
          this.logger.warn(
            `Analysis .md upload failed for "${attachment.filename}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (text.length > SANDBOX_TRUNCATE_LIMIT) {
        const paths = analysisPath
          ? `\n\n[Full analysis saved to sandbox at ${analysisPath}]\n[Original file saved to sandbox at ${actualPath}]`
          : `\n\n[Full file saved to sandbox at ${actualPath}]`;
        return {
          text: text.slice(0, SANDBOX_TRUNCATE_LIMIT) + paths,
          downloadedSize: buffer.length,
          sandboxPath: actualPath,
          usage,
        };
      }
      const suffix = analysisPath
        ? `\n\n[Analysis saved to sandbox at ${analysisPath}]\n[File also saved to sandbox at ${actualPath}]`
        : `\n\n[File also saved to sandbox at ${actualPath}]`;
      return {
        text: text + suffix,
        downloadedSize: buffer.length,
        sandboxPath: actualPath,
        usage,
      };
    } catch (error) {
      this.logger.warn(
        `Sandbox upload failed for "${attachment.filename}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        text:
          text +
          `\n\n[Warning: sandbox upload failed — file content is included above]`,
        downloadedSize: buffer.length,
        usage,
      };
    }
  }

  private async downloadFromMatrix(mxcUri: string): Promise<Buffer> {
    const client = MatrixManager.getInstance().getClient();
    if (!client) {
      throw new Error('Matrix client not available');
    }

    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      MATRIX_DOWNLOAD_TIMEOUT_MS,
    );

    try {
      const result = await client.mxClient.downloadContent(mxcUri);
      return result.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async downloadFromMatrixEvent(
    roomId: string,
    eventId: string,
  ): Promise<Buffer> {
    this.logger.log(`Fetching Matrix event ${eventId} from room ${roomId}`);
    const client = MatrixManager.getInstance().getClient();
    if (!client) {
      throw new Error('Matrix client not available');
    }

    const event = await client.mxClient.getEvent(roomId, eventId);
    if (!event.content) {
      throw new Error('Event has no content');
    }

    const isEncrypted = !!event.content.file;
    this.logger.log(
      `Event ${eventId} — encrypted: ${isEncrypted}, type: ${event.content.msgtype ?? event.type}`,
    );

    let data: Buffer;
    if (isEncrypted) {
      data = await client.mxClient.crypto.decryptMedia(event.content.file);
    } else {
      if (!event.content.url) {
        throw new Error('Event has no media URL');
      }
      const result = await client.mxClient.downloadContent(event.content.url);
      data = result.data;
    }

    this.logger.log(`Downloaded ${data.length} bytes from event ${eventId}`);
    return data;
  }

  /**
   * Validate that a URL does not point to an internal/private network address.
   * Prevents SSRF attacks via crafted or redirected URLs.
   */
  private validateUrlTarget(targetUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      throw new Error('Invalid URL');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Blocked URL scheme: ${parsed.protocol}`);
    }

    const hostname = parsed.hostname;
    for (const pattern of BLOCKED_HOST_PATTERNS) {
      if (pattern.test(hostname)) {
        throw new Error('URL points to a blocked internal address');
      }
    }
  }

  private async downloadFromUrl(
    url: string,
  ): Promise<{ data: Buffer; contentType?: string; finalUrl?: string }> {
    this.validateUrlTarget(url);

    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      MATRIX_DOWNLOAD_TIMEOUT_MS,
    );

    try {
      // Follow redirects manually so each hop is SSRF-validated.
      let currentUrl = url;
      let response: Response | undefined;

      for (let i = 0; i <= MAX_REDIRECT_COUNT; i++) {
        response = await fetch(currentUrl, {
          signal: abortController.signal,
          redirect: 'manual',
        });

        if (
          response.status >= 300 &&
          response.status < 400 &&
          response.headers.get('location')
        ) {
          const location = response.headers.get('location')!;
          currentUrl = new URL(location, currentUrl).toString();
          this.validateUrlTarget(currentUrl);
          this.logger.debug(
            `[downloadFromUrl] Redirect ${i + 1} → ${currentUrl}`,
          );
          continue;
        }

        break;
      }

      if (!response || (response.status >= 300 && response.status < 400)) {
        throw new Error('Too many redirects');
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} downloading ${url}`);
      }

      const contentType =
        response.headers.get('content-type')?.split(';')[0]?.trim() ??
        undefined;

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
        throw new Error(
          `File too large: server reports ${Math.round(parseInt(contentLength, 10) / 1024 / 1024)} MB (limit: ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB)`,
        );
      }

      // Stream the body with running size check to avoid OOM.
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.byteLength;
        if (totalBytes > MAX_FILE_SIZE) {
          void reader.cancel();
          throw new Error(
            `File exceeds maximum size (${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB) — download aborted`,
          );
        }
        chunks.push(value);
      }

      const finalUrl = currentUrl !== url ? currentUrl : undefined;

      return {
        data: Buffer.concat(chunks),
        contentType,
        finalUrl,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * HEAD a URL to determine Content-Type and Content-Length without
   * downloading the body. Follows redirects with SSRF validation.
   */
  private async headUrl(url: string): Promise<{
    contentType?: string;
    contentLength?: number;
    finalUrl: string;
  }> {
    this.validateUrlTarget(url);

    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      MATRIX_DOWNLOAD_TIMEOUT_MS,
    );

    try {
      let currentUrl = url;
      let response: Response | undefined;

      for (let i = 0; i <= MAX_REDIRECT_COUNT; i++) {
        response = await fetch(currentUrl, {
          method: 'HEAD',
          signal: abortController.signal,
          redirect: 'manual',
        });

        if (
          response.status >= 300 &&
          response.status < 400 &&
          response.headers.get('location')
        ) {
          const location = response.headers.get('location')!;
          currentUrl = new URL(location, currentUrl).toString();
          this.validateUrlTarget(currentUrl);
          continue;
        }

        break;
      }

      if (!response || (response.status >= 300 && response.status < 400)) {
        throw new Error('Too many redirects');
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from HEAD ${url}`);
      }

      const contentType =
        response.headers.get('content-type')?.split(';')[0]?.trim() ??
        undefined;
      const clHeader = response.headers.get('content-length');
      const contentLength = clHeader ? parseInt(clHeader, 10) : undefined;

      return { contentType, contentLength, finalUrl: currentUrl };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Detect the actual MIME type from the file's magic bytes.
   * Returns null if no known signature matches.
   */
  private detectMimeFromMagicBytes(buffer: Buffer): string | null {
    if (buffer.length < 4) return null;

    for (const sig of MAGIC_BYTES) {
      const offset = sig.offset ?? 0;
      if (buffer.length < offset + sig.bytes.length) continue;

      let match = true;
      for (let i = 0; i < sig.bytes.length; i++) {
        if (buffer[offset + i] !== sig.bytes[i]) {
          match = false;
          break;
        }
      }
      if (match) return sig.mime;
    }

    return null;
  }

  /**
   * Verify that the file's magic bytes are consistent with the claimed
   * mimetype category. For binary formats (images, audio, video, PDF)
   * this is strict. For text-based formats (text/plain, text/html, etc.)
   * we skip magic byte checks since they don't have reliable signatures.
   */
  private verifyMagicBytes(
    buffer: Buffer,
    claimedCategory: FileCategory,
    attachment: AttachmentDto,
  ): void {
    if (this.isPlainTextType(attachment.mimetype)) {
      return;
    }

    const detectedMime = this.detectMimeFromMagicBytes(buffer);

    if (!detectedMime) {
      this.logger.warn(
        `No magic bytes match for ${attachment.filename} (claimed: ${attachment.mimetype})`,
      );
      return;
    }

    const allowedCategories = MAGIC_MIME_CATEGORIES[detectedMime];
    if (!allowedCategories || !allowedCategories.includes(claimedCategory)) {
      throw new Error(
        `File content mismatch: claimed ${attachment.mimetype} but detected ${detectedMime}`,
      );
    }
  }

  private categorizeFile(mimetype: string): FileCategory {
    if (this.isDocumentType(mimetype)) return 'document';
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('audio/')) return 'audio';
    if (mimetype.startsWith('video/')) return 'video';
    return 'unsupported';
  }

  private isDocumentType(mimetype: string): boolean {
    return (
      mimetype.startsWith('text/') ||
      mimetype === 'application/pdf' ||
      mimetype === 'application/msword' ||
      mimetype === 'application/json' ||
      mimetype === 'application/xml' ||
      mimetype === 'application/rtf' ||
      mimetype.startsWith('application/vnd.openxmlformats-officedocument.') ||
      mimetype === 'application/vnd.ms-excel' ||
      mimetype === 'application/vnd.ms-powerpoint'
    );
  }

  private async processDocument(
    buffer: Buffer,
    attachment: AttachmentDto,
  ): Promise<{ text: string; usage?: AiProcessUsage }> {
    const safeFilename = this.sanitizeFilename(attachment.filename);

    if (this.isPlainTextType(attachment.mimetype)) {
      const text = buffer.toString('utf-8');
      return {
        text: this.formatContent(
          'Content',
          safeFilename,
          this.truncateText(text),
        ),
      };
    }

    try {
      const docs = await loadFileFromBuffer(
        buffer,
        attachment.mimetype,
        attachment.filename,
      );
      // PDFs return one Document per page — preserve the page boundary so the
      // model can cite "page N" downstream. Other doc types return one chunk.
      const isPdf = attachment.mimetype === 'application/pdf';
      const text =
        isPdf && docs.length > 1
          ? docs
              .map((doc, i) => `## Page ${i + 1}\n\n${doc.pageContent}`)
              .join('\n\n')
          : docs.map((doc) => doc.pageContent).join('\n\n');
      if (text.trim().length > 0) {
        return {
          text: this.formatContent(
            'Content',
            safeFilename,
            this.truncateText(text),
          ),
        };
      }
    } catch (error) {
      this.logger.warn(
        `Local parsing failed for ${attachment.filename}, falling back to AI: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const { content, usage } = await this.aiProcess(
      buffer,
      attachment.mimetype,
      'document',
      attachment.filename,
    );
    return {
      text: this.formatContent(
        'Content',
        safeFilename,
        this.truncateText(content),
      ),
      usage,
    };
  }

  private async processImage(
    buffer: Buffer,
    attachment: AttachmentDto,
  ): Promise<{ text: string; usage?: AiProcessUsage }> {
    const { content, usage } = await this.aiProcess(
      buffer,
      attachment.mimetype,
      'image',
      attachment.filename,
    );
    return {
      text: this.formatContent(
        'Description',
        this.sanitizeFilename(attachment.filename),
        content,
      ),
      usage,
    };
  }

  private async processAudio(
    buffer: Buffer,
    attachment: AttachmentDto,
  ): Promise<{ text: string; usage?: AiProcessUsage }> {
    const { content, usage } = await this.aiProcess(
      buffer,
      attachment.mimetype,
      'audio',
      attachment.filename,
    );
    return {
      text: this.formatContent(
        'Transcription',
        this.sanitizeFilename(attachment.filename),
        content,
      ),
      usage,
    };
  }

  private async processVideo(
    buffer: Buffer,
    attachment: AttachmentDto,
  ): Promise<{ text: string; usage?: AiProcessUsage }> {
    const { content, usage } = await this.aiProcess(
      buffer,
      attachment.mimetype,
      'video',
      attachment.filename,
    );
    return {
      text: this.formatContent(
        'Description',
        this.sanitizeFilename(attachment.filename),
        content,
      ),
      usage,
    };
  }

  /**
   * Send a public URL directly to OpenRouter for image/video processing
   * without downloading the file first. Faster and avoids OOM for large files.
   */
  private async aiProcessFromUrl(
    url: string,
    _mimetype: string,
    category: 'image' | 'video',
    _filename: string,
  ): Promise<AiProcessResult> {
    // The upstream model fetches `url` from its own infrastructure, so this
    // path bypasses our normal `downloadFromUrl` SSRF check. Validate here
    // so we can't be coerced into asking an external LLM to read internal
    // metadata endpoints or private network hosts.
    this.validateUrlTarget(url);

    const prompt = PROMPTS[category];

    const contentParts: Record<string, unknown>[] = [
      { type: 'text', text: prompt },
    ];

    if (category === 'image') {
      contentParts.push({
        type: 'image_url',
        image_url: { url },
      });
    } else {
      contentParts.push({
        type: 'video_url',
        video_url: { url },
      });
    }

    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      AI_PROCESS_TIMEOUT_MS,
    );

    try {
      const response = await fetch(`${this.providerBaseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.providerApiKey}`,
          'Content-Type': 'application/json',
          ...this.providerHeaders,
        },
        body: JSON.stringify({
          model: this.processingModel,
          messages: [
            {
              role: 'user',
              content: contentParts,
            },
          ],
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `OpenRouter API error (${response.status}): ${errorText.slice(0, MAX_ERROR_BODY_LENGTH)}`,
        );
        throw new Error(`AI processing failed (${response.status})`);
      }

      const result = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          cost?: number;
        };
        model?: string;
      };

      this.logger.log(
        `[aiProcessFromUrl] model=${result.model ?? 'unknown'} usage=${JSON.stringify(result.usage ?? null)}`,
      );

      return {
        content: result.choices[0]?.message?.content ?? '',
        usage: result.usage
          ? {
              cost: result.usage.cost,
              promptTokens: result.usage.prompt_tokens,
              completionTokens: result.usage.completion_tokens,
            }
          : undefined,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async aiProcess(
    buffer: Buffer,
    mimetype: string,
    category: Exclude<FileCategory, 'unsupported'>,
    filename: string,
  ): Promise<AiProcessResult> {
    const base64 = buffer.toString('base64');
    const dataUri = `data:${mimetype};base64,${base64}`;
    const prompt = PROMPTS[category];

    const contentParts: Record<string, unknown>[] = [
      { type: 'text', text: prompt },
    ];

    if (category === 'image') {
      contentParts.push({
        type: 'image_url',
        image_url: { url: dataUri },
      });
    } else if (category === 'audio') {
      contentParts.push({
        type: 'input_audio',
        input_audio: { data: base64, format: this.getAudioFormat(mimetype) },
      });
    } else if (category === 'document') {
      contentParts.push({
        type: 'file',
        file: { filename, file_data: dataUri },
      });
    } else if (category === 'video') {
      contentParts.push({
        type: 'video_url',
        video_url: { url: dataUri },
      });
    }

    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      AI_PROCESS_TIMEOUT_MS,
    );

    try {
      const response = await fetch(`${this.providerBaseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.providerApiKey}`,
          'Content-Type': 'application/json',
          ...this.providerHeaders,
        },
        body: JSON.stringify({
          model: this.processingModel,
          messages: [
            {
              role: 'user',
              content: contentParts,
            },
          ],
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `OpenRouter API error (${response.status}): ${errorText.slice(0, MAX_ERROR_BODY_LENGTH)}`,
        );
        throw new Error(`AI processing failed (${response.status})`);
      }

      const result = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          cost?: number;
        };
        model?: string;
      };

      this.logger.log(
        `[aiProcess] model=${result.model ?? 'unknown'} usage=${JSON.stringify(result.usage ?? null)}`,
      );

      return {
        content: result.choices[0]?.message?.content ?? '',
        usage: result.usage
          ? {
              cost: result.usage.cost,
              promptTokens: result.usage.prompt_tokens,
              completionTokens: result.usage.completion_tokens,
            }
          : undefined,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private getAudioFormat(
    mimetype: string,
  ): 'mp3' | 'wav' | 'ogg' | 'flac' | 'webm' | 'mp4' | 'aac' {
    if (mimetype.includes('mp3') || mimetype.includes('mpeg')) return 'mp3';
    if (mimetype.includes('wav')) return 'wav';
    if (mimetype.includes('ogg')) return 'ogg';
    if (mimetype.includes('flac')) return 'flac';
    if (mimetype.includes('webm')) return 'webm';
    if (mimetype.includes('mp4') || mimetype.includes('m4a')) return 'mp4';
    if (mimetype.includes('aac')) return 'aac';
    return 'mp3';
  }

  /**
   * Strip control characters and bracket sequences from filename
   * to prevent prompt injection when interpolated into LLM context.
   */
  private sanitizeFilename(filename: string): string {
    return (
      filename
        // eslint-disable-next-line no-control-regex
        .replace(/[ -]/g, '')
        .replace(/[[\]]/g, '')
        .slice(0, 255)
    );
  }

  /**
   * Plain-text mimetypes that can be read directly as UTF-8 without AI
   * processing or local parsers.
   */
  private isPlainTextType(mimetype: string): boolean {
    return (
      mimetype.startsWith('text/') ||
      mimetype === 'application/json' ||
      mimetype === 'application/xml' ||
      mimetype === 'application/rtf'
    );
  }

  private buildAnalysisMarkdown(
    filename: string,
    mimetype: string,
    sizeBytes: number,
    category: 'image' | 'video' | 'audio',
    content: string,
  ): string {
    const labels: Record<string, string> = {
      image: 'Image Description',
      video: 'Video Description',
      audio: 'Audio Transcription',
    };
    const label = labels[category] ?? 'Analysis';
    return [
      `# ${label}: ${filename}`,
      '',
      `- **File:** ${filename}`,
      `- **Type:** ${mimetype}`,
      `- **Size:** ${(sizeBytes / 1024).toFixed(1)} KB`,
      `- **Processed:** ${new Date().toISOString()}`,
      '',
      '---',
      '',
      content,
      '',
    ].join('\n');
  }

  private formatContent(
    label: string,
    filename: string,
    content: string,
  ): string {
    return `[${label} of ${filename}]:\n${content}`;
  }

  private truncateText(text: string): string {
    if (text.length <= MAX_TEXT_LENGTH) return text;
    return text.slice(0, MAX_TEXT_LENGTH) + '\n\n[...truncated]';
  }

  /**
   * Download and process a file in one pass, returning both the raw buffer
   * and extracted text. Used by the process_file tool when copy_to_sandbox
   * is enabled so the file isn't downloaded twice.
   */
  async downloadAndProcessFile(
    source: { url: string } | { eventId: string; roomId?: string },
    hints?: { filename?: string; mimetype?: string },
  ): Promise<{
    buffer: Buffer;
    text: string;
    resolvedFilename: string;
    resolvedMimetype: string;
  }> {
    let buffer: Buffer;
    let httpContentType: string | undefined;
    let finalUrl: string | undefined;

    if ('eventId' in source) {
      const roomId = source.roomId;
      if (!roomId) {
        throw new Error('roomId is required when using eventId');
      }
      buffer = await this.downloadFromMatrixEvent(roomId, source.eventId);
    } else {
      const url = source.url;
      if (!ALLOWED_URI_SCHEMES.test(url)) {
        throw new Error(
          'Invalid URI scheme — only http, https, and mxc are allowed',
        );
      }
      if (url.startsWith('mxc://')) {
        buffer = await this.downloadFromMatrix(url);
      } else {
        const result = await this.downloadFromUrl(url);
        buffer = result.data;
        httpContentType = result.contentType;
        finalUrl = result.finalUrl;
      }
    }

    this.logger.log(
      `[downloadAndProcessFile] Downloaded ${buffer.length} bytes`,
    );

    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error('File exceeds maximum size (25 MB)');
    }

    const url = 'url' in source ? source.url : undefined;
    const filename =
      hints?.filename ??
      (finalUrl ? this.extractFilenameFromUrl(finalUrl) : null) ??
      (url ? this.extractFilenameFromUrl(url) : null) ??
      'file';

    const extensionMime = this.guessMimeFromFilename(filename);
    const magicMime = this.detectMimeFromMagicBytes(buffer);
    const mimetype =
      hints?.mimetype ??
      extensionMime ??
      magicMime ??
      httpContentType ??
      'application/octet-stream';

    this.logger.log(
      `[downloadAndProcessFile] Resolved — filename="${filename}", mimetype="${mimetype}" ` +
        `(extension=${extensionMime}, magic=${magicMime}, http=${httpContentType})`,
    );

    const category = this.categorizeFile(mimetype);

    let text: string;
    if (category === 'unsupported') {
      const fallbackMime = magicMime ?? httpContentType;
      const fallbackCategory = fallbackMime
        ? this.categorizeFile(fallbackMime)
        : 'unsupported';

      if (fallbackCategory !== 'unsupported' && fallbackMime) {
        const attachment: AttachmentDto = { filename, mimetype: fallbackMime };
        this.verifyMagicBytes(buffer, fallbackCategory, attachment);
        text = await this.processCategory(buffer, fallbackCategory, attachment);
      } else {
        text = `[File "${this.sanitizeFilename(filename)}" (${mimetype}) is not a supported file type and could not be processed.]`;
      }
    } else {
      const attachment: AttachmentDto = { filename, mimetype };
      this.verifyMagicBytes(buffer, category, attachment);
      text = await this.processCategory(buffer, category, attachment);
    }

    return {
      buffer,
      text,
      resolvedFilename: filename,
      resolvedMimetype: mimetype,
    };
  }

  /**
   * Process a file from a Matrix event ID — downloads via
   * downloadFromMatrixEvent (handles encrypted + unencrypted) and routes
   * through the standard processCategory pipeline.
   */
  async processFileFromEventId(
    roomId: string,
    eventId: string,
    hints?: { filename?: string; mimetype?: string },
  ): Promise<string> {
    this.logger.log(
      `[processFileFromEventId] Starting — roomId=${roomId}, eventId=${eventId}, hints=${JSON.stringify(hints)}`,
    );

    const buffer = await this.downloadFromMatrixEvent(roomId, eventId);

    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error('File exceeds maximum size (25 MB)');
    }

    const filename = hints?.filename ?? 'file';
    const magicMime = this.detectMimeFromMagicBytes(buffer);
    const extensionMime = this.guessMimeFromFilename(filename);
    const mimetype =
      hints?.mimetype ??
      extensionMime ??
      magicMime ??
      'application/octet-stream';

    this.logger.log(
      `[processFileFromEventId] Resolved — filename="${filename}", mimetype="${mimetype}" ` +
        `(hints=${hints?.mimetype}, extension=${extensionMime}, magic=${magicMime})`,
    );

    const category = this.categorizeFile(mimetype);

    if (category === 'unsupported') {
      const fallbackMime = magicMime;
      const fallbackCategory = fallbackMime
        ? this.categorizeFile(fallbackMime)
        : 'unsupported';

      if (fallbackCategory !== 'unsupported' && fallbackMime) {
        const attachment: AttachmentDto = { filename, mimetype: fallbackMime };
        this.verifyMagicBytes(buffer, fallbackCategory, attachment);
        return this.processCategory(buffer, fallbackCategory, attachment);
      }

      return `[File "${this.sanitizeFilename(filename)}" (${mimetype}) is not a supported file type and could not be processed.]`;
    }

    const attachment: AttachmentDto = { filename, mimetype };
    this.verifyMagicBytes(buffer, category, attachment);
    return this.processCategory(buffer, category, attachment);
  }

  /**
   * Process a file from a URL and extract its content as text.
   * For HTTPS image/video URLs, passes the URL directly to the AI model (no download).
   * For audio/documents/mxc, downloads first then processes locally or via AI.
   * If the type can't be determined, tries AI passthrough before falling back to download.
   */
  async processFileFromUrl(
    url: string,
    hints?: { filename?: string; mimetype?: string },
  ): Promise<string> {
    this.logger.log(
      `[processFileFromUrl] Starting — url=${url}, hints=${JSON.stringify(hints)}`,
    );

    if (!ALLOWED_URI_SCHEMES.test(url)) {
      throw new Error(
        'Invalid URI scheme — only http, https, and mxc are allowed',
      );
    }

    if (url.startsWith('mxc://')) {
      return this.downloadAndProcess(url, hints);
    }

    const filename = hints?.filename ?? this.extractFilenameFromUrl(url);
    const extensionMime = this.guessMimeFromFilename(filename);
    const knownMime = hints?.mimetype ?? extensionMime;
    const knownCategory = knownMime ? this.categorizeFile(knownMime) : null;

    if (knownCategory === 'image' || knownCategory === 'video') {
      this.logger.log(
        `[processFileFromUrl] URL passthrough (${knownCategory}) — "${filename}" (${knownMime})`,
      );
      return this.tryUrlPassthrough(url, knownMime!, knownCategory, filename);
    }

    if (knownCategory === 'audio' || knownCategory === 'document') {
      this.logger.log(
        `[processFileFromUrl] Known ${knownCategory} — downloading "${filename}" (${knownMime})`,
      );
      return this.downloadAndProcess(url, hints);
    }

    this.logger.log(
      `[processFileFromUrl] Unknown type for "${filename}" — trying HEAD`,
    );

    let headContentType: string | undefined;
    let resolvedUrl = url;
    try {
      const head = await this.headUrl(url);
      headContentType = head.contentType;
      resolvedUrl = head.finalUrl;
    } catch (error) {
      this.logger.warn(
        `[processFileFromUrl] HEAD failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (headContentType) {
      // Ignore text/html — web pages usually wrap embedded media (YouTube, etc.)
      // and should fall through to the AI video passthrough below.
      const isHtmlPage = headContentType.startsWith('text/html');
      const headCategory = isHtmlPage
        ? 'unsupported'
        : this.categorizeFile(headContentType);

      if (headCategory === 'image' || headCategory === 'video') {
        this.logger.log(
          `[processFileFromUrl] HEAD says ${headCategory} (${headContentType}) — URL passthrough`,
        );
        return this.tryUrlPassthrough(
          resolvedUrl,
          headContentType,
          headCategory,
          filename,
        );
      }

      if (headCategory === 'audio' || headCategory === 'document') {
        this.logger.log(
          `[processFileFromUrl] HEAD says ${headCategory} (${headContentType}) — downloading`,
        );
        return this.downloadAndProcess(url, hints);
      }
    }

    // Try passing the URL to AI as video — Gemini natively handles YouTube,
    // Vimeo, and many other platforms that serve HTML pages with embedded video.
    // SSRF validation is performed inside `aiProcessFromUrl`.
    this.logger.log(
      `[processFileFromUrl] Type still unknown (HEAD Content-Type: ${headContentType ?? 'none'}) — trying AI video passthrough as fallback`,
    );
    try {
      const { content } = await this.aiProcessFromUrl(
        resolvedUrl,
        'video/mp4',
        'video',
        filename,
      );
      if (content && content.trim().length > 0) {
        this.logger.log(
          `[processFileFromUrl] AI video passthrough succeeded for "${filename}"`,
        );
        return this.formatContent(
          'Description',
          this.sanitizeFilename(filename),
          content,
        );
      }
    } catch (error) {
      this.logger.warn(
        `[processFileFromUrl] AI video passthrough failed, falling back to download: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.logger.log(
      `[processFileFromUrl] All passthrough attempts failed — downloading "${filename}"`,
    );
    return this.downloadAndProcess(url, hints);
  }

  /**
   * Try passing a URL directly to AI for image/video processing.
   * Falls back to download + process if the AI rejects it.
   */
  private async tryUrlPassthrough(
    url: string,
    mimetype: string,
    category: 'image' | 'video',
    filename: string,
  ): Promise<string> {
    try {
      const { content } = await this.aiProcessFromUrl(
        url,
        mimetype,
        category,
        filename,
      );
      if (content && content.trim().length > 0) {
        return this.formatContent(
          'Description',
          this.sanitizeFilename(filename),
          content,
        );
      }
      this.logger.warn(
        `[tryUrlPassthrough] AI returned empty response for "${filename}", falling back to download`,
      );
    } catch (error) {
      this.logger.warn(
        `[tryUrlPassthrough] AI passthrough failed for "${filename}", falling back to download: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.downloadAndProcess(url, { filename, mimetype });
  }

  /**
   * Download a URL (or mxc:// resource) into memory and process from the buffer.
   * Handles size validation, mime detection from bytes, and category routing.
   */
  private async downloadAndProcess(
    url: string,
    hints?: { filename?: string; mimetype?: string },
  ): Promise<string> {
    let buffer: Buffer;
    let httpContentType: string | undefined;
    let finalUrl: string | undefined;

    if (url.startsWith('mxc://')) {
      buffer = await this.downloadFromMatrix(url);
    } else {
      const result = await this.downloadFromUrl(url);
      buffer = result.data;
      httpContentType = result.contentType;
      finalUrl = result.finalUrl;
    }

    this.logger.log(
      `[downloadAndProcess] Downloaded ${buffer.length} bytes, HTTP Content-Type: ${httpContentType ?? 'none'}` +
        (finalUrl ? `, redirected to: ${finalUrl}` : ''),
    );

    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error('File exceeds maximum size (25 MB)');
    }

    const filename =
      hints?.filename ??
      (finalUrl ? this.extractFilenameFromUrl(finalUrl) : null) ??
      this.extractFilenameFromUrl(url);

    const extensionMime = this.guessMimeFromFilename(filename);
    const magicMime = this.detectMimeFromMagicBytes(buffer);
    const mimetype =
      hints?.mimetype ??
      extensionMime ??
      magicMime ??
      httpContentType ??
      'application/octet-stream';

    this.logger.log(
      `[downloadAndProcess] Resolved — filename="${filename}", mimetype="${mimetype}" ` +
        `(extension=${extensionMime}, magic=${magicMime}, http=${httpContentType})`,
    );

    const category = this.categorizeFile(mimetype);

    if (category === 'unsupported') {
      const fallbackMime = magicMime ?? httpContentType;
      const fallbackCategory = fallbackMime
        ? this.categorizeFile(fallbackMime)
        : 'unsupported';

      if (fallbackCategory !== 'unsupported' && fallbackMime) {
        this.logger.log(
          `[downloadAndProcess] Fallback mime "${fallbackMime}" → ${fallbackCategory}`,
        );
        const attachment: AttachmentDto = { filename, mimetype: fallbackMime };
        this.verifyMagicBytes(buffer, fallbackCategory, attachment);
        return this.processCategory(buffer, fallbackCategory, attachment);
      }

      this.logger.warn(
        `[downloadAndProcess] Unsupported file type: ${mimetype} for ${filename}`,
      );
      return `[File "${this.sanitizeFilename(filename)}" (${mimetype}) is not a supported file type and could not be processed.]`;
    }

    const attachment: AttachmentDto = { filename, mimetype };
    this.verifyMagicBytes(buffer, category, attachment);
    return this.processCategory(buffer, category, attachment);
  }

  /**
   * Route a validated buffer to the correct processor by category.
   */
  private async processCategory(
    buffer: Buffer,
    category: Exclude<FileCategory, 'unsupported'>,
    attachment: AttachmentDto,
  ): Promise<string> {
    this.logger.log(
      `[processCategory] Processing "${attachment.filename}" as ${category} (${attachment.mimetype}, ${buffer.length} bytes)`,
    );

    let result: { text: string; usage?: AiProcessUsage };
    switch (category) {
      case 'document':
        result = await this.processDocument(buffer, attachment);
        break;
      case 'image':
        result = await this.processImage(buffer, attachment);
        break;
      case 'audio':
        result = await this.processAudio(buffer, attachment);
        break;
      case 'video':
        result = await this.processVideo(buffer, attachment);
        break;
    }
    return result.text;
  }

  /**
   * Best-effort filename extraction from a URL path.
   * Falls back to 'download' if nothing useful can be derived.
   */
  private extractFilenameFromUrl(url: string): string {
    try {
      const pathname = new URL(url).pathname;
      const lastSegment = pathname.split('/').filter(Boolean).pop();
      if (lastSegment) {
        return decodeURIComponent(lastSegment).slice(0, 255);
      }
    } catch {
      // Malformed URL — fall through.
    }
    return 'download';
  }

  /**
   * Map common file extensions to MIME types.
   * Returns null if the extension is unknown.
   */
  private guessMimeFromFilename(filename: string): string | null {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (!ext) return null;

    const map: Record<string, string> = {
      // Documents
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      xls: 'application/vnd.ms-excel',
      ppt: 'application/vnd.ms-powerpoint',
      rtf: 'application/rtf',
      // Text / code
      txt: 'text/plain',
      md: 'text/markdown',
      html: 'text/html',
      htm: 'text/html',
      csv: 'text/csv',
      json: 'application/json',
      xml: 'application/xml',
      css: 'text/css',
      js: 'text/javascript',
      ts: 'text/plain',
      py: 'text/x-python',
      yaml: 'text/yaml',
      yml: 'text/yaml',
      // Images
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      bmp: 'image/bmp',
      tiff: 'image/tiff',
      tif: 'image/tiff',
      // Audio
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      flac: 'audio/flac',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      // Video
      webm: 'video/webm',
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      avi: 'video/x-msvideo',
      mkv: 'video/x-matroska',
      '3gp': 'video/3gpp',
    };

    return map[ext] ?? null;
  }
}
