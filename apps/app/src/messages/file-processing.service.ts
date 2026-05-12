import { loadFileFromBuffer } from '@ixo/common';
import { getModelForRole, getProviderConfig } from '@ixo/oracle-runtime';
import { MatrixManager } from '@ixo/matrix';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ENV } from 'src/types';
import { type AttachmentDto } from './dto/send-message.dto';

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
const MATRIX_DOWNLOAD_TIMEOUT_MS = 60_000; // 60s
const AI_PROCESS_TIMEOUT_MS = 120_000; // 120s
const MAX_ERROR_BODY_LENGTH = 1024; // Cap error response bodies

const SANDBOX_TRUNCATE_LIMIT = 500;
const SANDBOX_OUTPUT_PREFIX = '/workspace/output';

const ALLOWED_URI_SCHEMES = /^(mxc|https?):\/\//i;
const MAX_REDIRECT_COUNT = 5;

/**
 * Block list for SSRF protection.
 * Prevents redirects to internal/cloud metadata endpoints.
 */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/, // AWS/cloud metadata
  /^0\.0\.0\.0$/,
  /^\[::1?\]$/, // IPv6 loopback
  /^metadata\.google\.internal$/i,
];

/**
 * Magic byte signatures for common file types.
 * Maps a detected mimetype to the byte signature(s) that identify it.
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
  { bytes: [0x00, 0x00, 0x00], mime: 'video/mp4' }, // MP4/MOV (ftyp box, 4th byte varies)
];

/**
 * Category groupings for magic byte matching.
 * Maps a detected magic mime to the broad categories it's compatible with.
 */
const MAGIC_MIME_CATEGORIES: Record<string, FileCategory[]> = {
  'image/png': ['image'],
  'image/jpeg': ['image'],
  'image/gif': ['image'],
  'image/webp': ['image'],
  'image/bmp': ['image'],
  'image/tiff': ['image'],
  'application/pdf': ['document'],
  'application/zip': ['document'], // docx/xlsx are ZIP archives
  'application/msword': ['document'],
  'audio/mpeg': ['audio'],
  'audio/ogg': ['audio'],
  'audio/flac': ['audio'],
  'video/webm': ['video', 'audio'], // WebM can be audio-only
  'video/mp4': ['video', 'audio'], // MP4 can be audio-only (m4a)
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
  sandboxMcpUrl: string;
  userToken: string;
  oracleToken: string;
  homeServerName: string;
  oracleHomeServerUrl: string;
}

const PROMPTS: Record<Exclude<FileCategory, 'unsupported'>, string> = {
  document: 'Extract all text content from this document verbatim.',
  image:
    'Describe this image in detail. Include all text, numbers, labels, and visual elements.',
  audio: 'Transcribe this audio completely. Include all spoken words.',
  video:
    'Describe this video in detail. Include actions, text overlays, and spoken content.',
};

@Injectable()
export class FileProcessingService {
  private readonly logger = new Logger(FileProcessingService.name);
  private readonly providerApiKey: string;
  private readonly providerBaseURL: string;
  private readonly providerHeaders: Record<string, string>;
  private readonly processingModel: string;

  constructor(private readonly config: ConfigService<ENV>) {
    const providerCfg = getProviderConfig();
    this.providerApiKey = providerCfg.apiKey;
    this.providerBaseURL = providerCfg.baseURL.replace(/\/+$/, '');
    this.providerHeaders = providerCfg.headers;
    this.processingModel = getModelForRole('vision');
  }

  /**
   * Upload a file to the sandbox via its HTTP artifacts endpoint.
   * Derives the API base URL from SANDBOX_MCP_URL by stripping the /mcp suffix.
   */
  /**
   * Sanitize a filename/path for the sandbox upload endpoint.
   * Only alphanumeric, dots, dashes, underscores, and slashes are allowed.
   */
  private sanitizeSandboxPath(p: string): string {
    return p.replace(/[^a-zA-Z0-9._\-/]/g, '_');
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

    // Resolve MIME type — the upload endpoint rejects application/octet-stream
    const resolvedMime =
      mimetype ??
      this.guessMimeFromFilename(filename) ??
      'application/octet-stream';

    // Sanitize filename and path — endpoint only allows [a-zA-Z0-9._\-/]
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
      headers: {
        Authorization: `Bearer ${sandboxConfig.userToken}`,
        'x-matrix-homeserver': sandboxConfig.homeServerName,
        'X-oracle-openid-token': sandboxConfig.oracleToken,
        'x-oracle-homeserver': sandboxConfig.oracleHomeServerUrl,
      },
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
    sandboxConfig?: SandboxUploadConfig,
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

    // Pre-validate total size budget from client-reported sizes
    const reportedTotal = attachments.reduce(
      (sum, a) => sum + (a.size ?? 0),
      0,
    );
    if (reportedTotal > MAX_TOTAL_SIZE) {
      throw new Error(
        `Total attachment size (${Math.round(reportedTotal / 1024 / 1024)} MB) exceeds budget (${Math.round(MAX_TOTAL_SIZE / 1024 / 1024)} MB)`,
      );
    }

    // Process all attachments in parallel
    const results = await Promise.all(
      attachments.map(async (attachment) => {
        this.logger.log(
          `Attachment: "${attachment.filename}" (${attachment.mimetype}, ${attachment.size ?? 'unknown'} bytes) — source: ${attachment.eventId ? `eventId=${attachment.eventId}` : `mxcUri=${attachment.mxcUri}`}`,
        );
        try {
          const { text, downloadedSize, sandboxPath, usage } =
            await this.processAttachment(attachment, 0, roomId, sandboxConfig);
          this.logger.log(
            `Attachment "${attachment.filename}" processed — downloaded ${downloadedSize} bytes, text extracted: ${text ? text.length + ' chars' : 'none'}`,
          );
          const category = this.categorizeFile(attachment.mimetype);
          return {
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
                    category === 'unsupported'
                      ? ('document' as const)
                      : category,
                  sandboxPath,
                }
              : null,
          };
        } catch (error) {
          this.logger.error(
            `Failed to process attachment ${attachment.filename}: ${error instanceof Error ? error.message : String(error)}`,
          );
          const errorText = `[File "${this.sanitizeFilename(attachment.filename)}" (${attachment.mimetype}) failed to process: ${error instanceof Error ? error.message : 'unknown error'}. Let the user know this file could not be read.]`;
          const category = this.categorizeFile(attachment.mimetype);
          return {
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
            } as ProcessedAttachment,
          };
        }
      }),
    );

    // Validate total downloaded size after parallel completion
    const totalDownloaded = results.reduce(
      (sum, r) => sum + r.downloadedSize,
      0,
    );
    if (totalDownloaded > MAX_TOTAL_SIZE) {
      throw new Error(
        `Total downloaded size (${Math.round(totalDownloaded / 1024 / 1024)} MB) exceeds budget (${Math.round(MAX_TOTAL_SIZE / 1024 / 1024)} MB)`,
      );
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

    return { texts, metadata, totalUsage };
  }

  private async processAttachment(
    attachment: AttachmentDto,
    currentTotalSize: number,
    roomId: string,
    sandboxConfig?: SandboxUploadConfig,
  ): Promise<{
    text: string | null;
    downloadedSize: number;
    sandboxPath?: string;
    usage?: AiProcessUsage;
  }> {
    // Validate that at least one source is provided
    if (!attachment.eventId && !attachment.mxcUri) {
      throw new Error('Either mxcUri or eventId must be provided');
    }

    // Validate URI scheme at runtime when mxcUri is present (defense-in-depth, DTO also validates)
    if (attachment.mxcUri && !ALLOWED_URI_SCHEMES.test(attachment.mxcUri)) {
      throw new Error('Invalid URI scheme');
    }

    // Validate file size from client-reported value
    if (attachment.size && attachment.size > MAX_FILE_SIZE) {
      throw new Error('File exceeds maximum size');
    }

    // Check total budget before downloading
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

    // For HTTP image/video URLs, try AI URL passthrough first (no download needed)
    const isHttpUrl =
      attachment.mxcUri &&
      !attachment.eventId &&
      /^https?:\/\//i.test(attachment.mxcUri);
    if (isHttpUrl && (category === 'image' || category === 'video')) {
      try {
        const { content, usage } = await this.aiProcessFromUrl(
          attachment.mxcUri!,
          attachment.mimetype,
          category,
          attachment.filename,
        );
        if (content && content.trim().length > 0) {
          const label = category === 'image' ? 'Description' : 'Description';
          const text = this.formatContent(
            label,
            this.sanitizeFilename(attachment.filename),
            content,
          );
          // No buffer downloaded, so downloadedSize is 0 for budget tracking
          // Sandbox upload skipped (no buffer), but text is still available
          return { text, downloadedSize: 0, usage };
        }
      } catch (error) {
        this.logger.warn(
          `URL passthrough failed for "${attachment.filename}", falling back to download: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Download from the appropriate source
    let buffer: Buffer;
    if (attachment.eventId) {
      buffer = await this.downloadFromMatrixEvent(roomId, attachment.eventId);
    } else if (attachment.mxcUri!.startsWith('mxc://')) {
      buffer = await this.downloadFromMatrix(attachment.mxcUri!);
    } else {
      const result = await this.downloadFromUrl(attachment.mxcUri!);
      buffer = result.data;
    }

    // Check actual downloaded size
    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error('File exceeds maximum size');
    }

    // Verify magic bytes match claimed mimetype category
    this.verifyMagicBytes(buffer, category, attachment);

    let text: string;
    let usage: AiProcessUsage | undefined;
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

    // Upload to sandbox if config is provided
    if (sandboxConfig) {
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

    return { text, downloadedSize: buffer.length, usage };
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

    // Only allow http/https
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
    // Validate the initial URL against SSRF blocklist
    this.validateUrlTarget(url);

    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      MATRIX_DOWNLOAD_TIMEOUT_MS,
    );

    try {
      // Follow redirects manually to validate each hop
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
          // Resolve relative redirects
          currentUrl = new URL(location, currentUrl).toString();
          // Validate the redirect target
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

      // Check Content-Length header early to reject obviously oversized files
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
        throw new Error(
          `File too large: server reports ${Math.round(parseInt(contentLength, 10) / 1024 / 1024)} MB (limit: ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB)`,
        );
      }

      // Stream the body with a running size check to avoid OOM
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
   * Perform a HEAD request to determine Content-Type and Content-Length
   * without downloading the body. Follows redirects with SSRF validation.
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
    // Text-based document types don't have magic bytes — skip check
    if (this.isPlainTextType(attachment.mimetype)) {
      return;
    }

    const detectedMime = this.detectMimeFromMagicBytes(buffer);

    // If we can't detect the mime, log a warning but allow processing
    // (covers less common formats without known signatures)
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

    // Plain-text types — parse directly, no AI needed
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

    // Try local parsing first (free)
    try {
      const docs = await loadFileFromBuffer(
        buffer,
        attachment.mimetype,
        attachment.filename,
      );
      const text = docs.map((doc) => doc.pageContent).join('\n\n');
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

    // Fallback: send to AI model for extraction
    const { content, usage } = await this.aiProcess(
      buffer,
      attachment.mimetype,
      'document',
      attachment.filename,
    );
    return {
      text: this.formatContent('Content', safeFilename, content),
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
        // Log full error server-side, throw generic message
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
    return 'mp3'; // default
  }

  /**
   * Strip control characters and bracket sequences from filename
   * to prevent prompt injection when interpolated into LLM context.
   */
  private sanitizeFilename(filename: string): string {
    return (
      filename
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, '') // strip control chars
        .replace(/[[\]]/g, '') // strip brackets to prevent [SYSTEM: ...] injection
        .slice(0, 255)
    );
  }

  /**
   * Check if a mimetype represents a plain-text format that can be read
   * directly as UTF-8 without AI processing or local parsers.
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
   * is enabled so we avoid downloading the file twice.
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
   * Process a file from a Matrix event ID.
   * Downloads via downloadFromMatrixEvent (handles encrypted + unencrypted)
   * and routes through the standard processCategory pipeline.
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
      // Try fallback from magic bytes
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

    // Validate URI scheme
    if (!ALLOWED_URI_SCHEMES.test(url)) {
      throw new Error(
        'Invalid URI scheme — only http, https, and mxc are allowed',
      );
    }

    // ── mxc:// — always download (private Matrix media, not accessible by AI) ──
    if (url.startsWith('mxc://')) {
      return this.downloadAndProcess(url, hints);
    }

    // ── HTTPS — try to determine type and route accordingly ──
    const filename = hints?.filename ?? this.extractFilenameFromUrl(url);
    const extensionMime = this.guessMimeFromFilename(filename);
    const knownMime = hints?.mimetype ?? extensionMime;
    const knownCategory = knownMime ? this.categorizeFile(knownMime) : null;

    // If we already know it's image/video from hints or extension, pass URL directly
    if (knownCategory === 'image' || knownCategory === 'video') {
      this.logger.log(
        `[processFileFromUrl] URL passthrough (${knownCategory}) — "${filename}" (${knownMime})`,
      );
      return this.tryUrlPassthrough(url, knownMime!, knownCategory, filename);
    }

    // If we already know it's audio/document, download directly (no HEAD needed)
    if (knownCategory === 'audio' || knownCategory === 'document') {
      this.logger.log(
        `[processFileFromUrl] Known ${knownCategory} — downloading "${filename}" (${knownMime})`,
      );
      return this.downloadAndProcess(url, hints);
    }

    // ── Unknown type — use HEAD to figure it out ──
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

    // ── Still unknown (e.g. text/html from YouTube, no Content-Type) ──
    // Try passing the URL to AI as video — Gemini natively handles YouTube,
    // Vimeo, and many other platforms that serve HTML pages with embedded video.
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
      // If the AI returned a meaningful response, use it
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

    // ── Last resort — download and process from bytes ──
    this.logger.log(
      `[processFileFromUrl] All passthrough attempts failed — downloading "${filename}"`,
    );
    return this.downloadAndProcess(url, hints);
  }

  /**
   * Try passing a URL directly to AI for image/video processing.
   * If the AI rejects it, falls back to download + process.
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
      // Malformed URL — fall through
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
