/**
 * Archive an attachment's original bytes (and, for media, the helper model's
 * analysis) into the user's sandbox at `/workspace/output/<name>` — the Node
 * `FileProcessingService.uploadToSandbox` contract: multipart `file` + `path`
 * to `<SANDBOX_MCP_URL without /mcp>/artifacts/upload`, authenticated with
 * the same `Authorization: Bearer <ucan>` + `X-Auth-Type: ucan` the sandbox
 * MCP client sends.
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
  // Copy into a fresh ArrayBuffer-backed view so the Blob never sees a
  // SharedArrayBuffer-typed slice (the DOM lib types reject those).
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  formData.set(
    'file',
    new File([copy.buffer], safeFilename, { type: mimetype }),
  );
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
  const result = raw as { path?: string; url?: string; previewUrl?: string };
  return {
    path: typeof result.path === 'string' ? result.path : safePath,
    ...(result.url ? { url: result.url } : {}),
    ...(result.previewUrl ? { previewUrl: result.previewUrl } : {}),
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
