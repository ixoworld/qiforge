/**
 * Archive an attachment's original bytes (and, for media, the helper model's
 * analysis) into the user's sandbox at `/workspace/output/<name>` — the Node
 * `FileProcessingService.uploadToSandbox` contract: multipart `file` + `path`
 * to `<SANDBOX_MCP_URL without /mcp>/artifacts/upload`, authenticated with
 * the same `Authorization: Bearer <ucan>` + `X-Auth-Type: ucan` the sandbox
 * MCP client sends.
 *
 * The endpoint parses the whole multipart body (`Request.formData()`) and
 * refuses a file over 25 MB with `413`, so the pipeline never reads a file
 * over `MAX_FILE_SIZE` only to archive it, and a streamed body would buy
 * nothing: every archived file is one the turn already holds in memory.
 */
import { sanitizeSandboxPath } from './sanitize';

export interface SandboxUploadConfig {
  sandboxMcpUrl: string;
  authHeaders: Record<string, string>;
}

export interface SandboxUploadResult {
  path: string;
  url?: string;
  previewUrl?: string;
}

const MAX_ERROR_BODY_LENGTH = 1024;

export async function uploadToSandbox(
  bytes: Uint8Array,
  filename: string,
  destPath: string,
  config: SandboxUploadConfig,
  mimetype: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SandboxUploadResult> {
  const baseUrl = config.sandboxMcpUrl.replace(/\/mcp\/?$/, '');
  const safeFilename = sanitizeSandboxPath(filename);
  const safePath = sanitizeSandboxPath(destPath);
  const formData = new FormData();
  // A view over a plain ArrayBuffer goes into the Blob as it is (no second
  // copy of a file of up to 25 MB); only a SharedArrayBuffer-backed one —
  // which the Blob types reject — is copied.
  const buffer = bytes.buffer;
  const part =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength)
      : Uint8Array.from(bytes);
  formData.set('file', new File([part], safeFilename, { type: mimetype }));
  formData.set('path', safePath);
  const response = await fetchImpl(`${baseUrl}/artifacts/upload`, {
    method: 'POST',
    headers: { ...config.authHeaders },
    body: formData,
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `Sandbox upload failed (${response.status}): ${errorText.slice(0, MAX_ERROR_BODY_LENGTH)}`,
    );
  }
  const raw: unknown = await response.json();
  const field = (name: string): string | undefined => {
    const value: unknown =
      typeof raw === 'object' && raw !== null ? Reflect.get(raw, name) : null;
    return typeof value === 'string' && value ? value : undefined;
  };
  const url = field('url');
  const previewUrl = field('previewUrl');
  return {
    path: field('path') ?? safePath,
    ...(url ? { url } : {}),
    ...(previewUrl ? { previewUrl } : {}),
  };
}

/** The `<name>-analysis.md` the extraction lane stores next to media files. */
export function buildAnalysisMarkdown(
  filename: string,
  mimetype: string,
  sizeBytes: number,
  category: 'image' | 'video' | 'audio',
  content: string,
): string {
  const labels: Record<'image' | 'video' | 'audio', string> = {
    image: 'Image description',
    video: 'Video description',
    audio: 'Audio transcription',
  };
  return [
    `# ${labels[category]}: ${filename}`,
    '',
    `- **File:** ${filename}`,
    `- **Type:** ${mimetype}`,
    `- **Size:** ${sizeBytes} bytes`,
    `- **Processed:** ${new Date().toISOString()}`,
    '',
    '## Analysis',
    '',
    content,
  ].join('\n');
}
