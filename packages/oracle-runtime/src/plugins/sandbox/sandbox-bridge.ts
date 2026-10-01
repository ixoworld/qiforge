import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { z } from 'zod';
import type { RuntimeContext } from '../../plugin-api/types.js';
import {
  createDefaultAuthBuilder,
  SANDBOX_RUN_TOOL_NAME,
} from './sandbox-mcp.js';
import type {
  SandboxMcpClientFactory,
  SandboxMcpClientLike,
  SandboxMcpTool,
} from './sandbox.plugin.js';

/** Upstream tool name the sandbox MCP surfaces for byte-perfect file writes. */
export const SANDBOX_WRITE_FILE_TOOL_NAME = 'sandbox_write_file';

/** Per-call timeout for the sandbox MCP client (matches sandbox.plugin.ts). */
const SANDBOX_MCP_TIMEOUT_MS = 180_000;

/** Only destination the sandbox accepts for `sandbox_write_file` writes. */
export const WORKSPACE_DATA_PREFIX = '/workspace/data/';

/** Sentinel echoed by the read command when the source file is absent. */
export const SANDBOX_NO_FILE_SENTINEL = '__SANDBOX_NOFILE__';

/**
 * Shown when the user hasn't authorized the oracle to use the sandbox — the
 * default auth builder can't mint an `ixo:sandbox` invocation, so there's no
 * `Authorization` header to connect with. Non-throwing degradation.
 */
export const SANDBOX_NOT_AUTHORIZED_MESSAGE =
  "You haven't authorized the sandbox yet — grant sandbox access in the portal so I can move files between it and your files.";

/**
 * Default sandbox MCP-client factory. Wraps a real `MultiServerMCPClient` in
 * the minimal {@link SandboxMcpClientLike} surface the bridge needs, adapting
 * each upstream `DynamicStructuredTool` into a plain {@link SandboxMcpTool}.
 * Tests inject a stub instead so no real MCP connection is opened.
 */
export const defaultSandboxMcpClientFactory: SandboxMcpClientFactory = (
  config,
) => {
  const client = new MultiServerMCPClient(config);
  const wrapper: SandboxMcpClientLike = {
    getTools: async () => {
      const tools = await client.getTools();
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        // The schema is never read by the bridge (we only `invoke`); keep the
        // upstream Zod schema when present, else a permissive placeholder.
        schema: t.schema instanceof z.ZodType ? t.schema : z.unknown(),
        invoke: (input: unknown) => t.invoke(input),
      }));
    },
    close: () => client.close(),
  };
  return wrapper;
};

/** Live sandbox `sandbox_run` + `sandbox_write_file` handles plus a closer. */
export interface SandboxBridge {
  run: SandboxMcpTool;
  writeFile: SandboxMcpTool;
  /** Always safe — swallows and logs any close error. */
  close: () => Promise<void>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** MIME map skewed toward binary outputs; unknown extensions stay opaque. */
const EXT_MIME: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/plain',
  py: 'text/x-python',
  sh: 'application/x-sh',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** Best-effort MIME type for a path, from its extension. */
export function inferMimeFromPath(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

/** `true` when the path sits under the sandbox's writable data root. */
export function isUnderWorkspaceData(path: string): boolean {
  return path.startsWith(WORKSPACE_DATA_PREFIX);
}

/**
 * `true` when a sandbox path can't be safely single-quoted into a shell
 * command (`sandbox_run`). We reject rather than risk breaking the command.
 */
export function hasShellUnsafeChars(path: string): boolean {
  return path.includes("'") || path.includes('\n') || path.includes('\0');
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export interface SandboxOutcome {
  /** `false` when the envelope reports `success:false` or a non-zero exit. */
  ok: boolean;
  /** Captured stdout when the envelope exposes it, else the whole result. */
  output: string;
  /** The stringified result, for surfacing in an error message. */
  text: string;
}

/**
 * Read a sandbox MCP result defensively. The upstream returns either a JSON
 * envelope (`{ success, exitCode, output, ... }`) or a bare string; both are
 * handled. `output` is the captured stdout when present, otherwise the whole
 * stringified result.
 *
 * ASSUMPTION (verify against a live sandbox): stdout lives in the `output`
 * field and `success` / `exitCode` are top-level — the shape the sandbox
 * manifest documents.
 */
export function readSandboxResult(result: unknown): SandboxOutcome {
  const text = typeof result === 'string' ? result : safeStringify(result);

  let envelope: unknown = isRecord(result) ? result : undefined;
  if (typeof result === 'string') {
    try {
      envelope = JSON.parse(result);
    } catch {
      envelope = undefined;
    }
  }

  let output: string | undefined;
  let success: boolean | undefined;
  let exitCode: number | undefined;
  if (isRecord(envelope)) {
    if (typeof envelope.output === 'string') output = envelope.output;
    if (typeof envelope.success === 'boolean') success = envelope.success;
    if (typeof envelope.exitCode === 'number') exitCode = envelope.exitCode;
  }

  const failedByFlag = success === false || /"success"\s*:\s*false/i.test(text);
  const failedByExit = exitCode !== undefined && exitCode !== 0;
  return { ok: !failedByFlag && !failedByExit, output: output ?? text, text };
}

/**
 * Mint sandbox auth headers, connect an MCP client, and resolve the two tools
 * the bridge needs. Non-throwing: every failure comes back as `{ error }` with
 * an agent-facing message. On success the caller MUST `close()` in a finally.
 */
export async function getSandboxBridge(
  rtCtx: RuntimeContext,
  sandboxMcpUrl: string,
  mcpClientFactory: SandboxMcpClientFactory = defaultSandboxMcpClientFactory,
): Promise<SandboxBridge | { error: string }> {
  let headers: Record<string, string>;
  try {
    headers = await createDefaultAuthBuilder()(
      { sandboxMcpUrl, oracleSecrets: {}, userSecrets: {} },
      rtCtx,
    );
  } catch (err) {
    rtCtx.logger.warn(
      `[sandbox-bridge] sandbox auth failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { error: SANDBOX_NOT_AUTHORIZED_MESSAGE };
  }

  if (!headers.Authorization) {
    return { error: SANDBOX_NOT_AUTHORIZED_MESSAGE };
  }

  const client = mcpClientFactory({
    mcpServers: {
      sandbox: {
        type: 'http',
        url: sandboxMcpUrl,
        transport: 'http',
        headers,
      },
    },
    defaultToolTimeout: SANDBOX_MCP_TIMEOUT_MS,
    useStandardContentBlocks: true,
  });

  const close = async (): Promise<void> => {
    try {
      await client.close();
    } catch (err) {
      rtCtx.logger.warn(
        `[sandbox-bridge] failed to close sandbox MCP client: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  let tools: SandboxMcpTool[];
  try {
    tools = await client.getTools();
  } catch (err) {
    await close();
    rtCtx.logger.warn(
      `[sandbox-bridge] could not list sandbox tools: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { error: 'Could not connect to the sandbox right now.' };
  }

  const run = tools.find((t) => t.name === SANDBOX_RUN_TOOL_NAME);
  const writeFile = tools.find((t) => t.name === SANDBOX_WRITE_FILE_TOOL_NAME);
  if (!run || !writeFile) {
    await close();
    return {
      error:
        'The sandbox is not exposing the file tools needed to move files right now.',
    };
  }

  return { run, writeFile, close };
}

/**
 * Read a file out of the sandbox as bytes, base64-hopping over `sandbox_run`
 * so binary content survives the transport. Non-throwing — a missing file, a
 * failed command, and undecodable output all come back as `{ error }` with an
 * agent-facing message.
 */
export async function readSandboxFile(
  bridge: Pick<SandboxBridge, 'run'>,
  sandboxPath: string,
): Promise<{ bytes: Buffer } | { error: string }> {
  const read = readSandboxResult(
    await bridge.run.invoke({
      code: `test -f '${sandboxPath}' && base64 -w0 '${sandboxPath}' || echo ${SANDBOX_NO_FILE_SENTINEL}`,
    }),
  );
  if (!read.ok) {
    return {
      error: `Couldn't read \`${sandboxPath}\` from the sandbox: ${truncate(read.text)}`,
    };
  }
  const stdout = read.output.trim();
  if (stdout === SANDBOX_NO_FILE_SENTINEL) {
    return { error: `No file at \`${sandboxPath}\` in the sandbox.` };
  }
  return { bytes: Buffer.from(stdout, 'base64') };
}

/**
 * Write a file into the sandbox via `sandbox_write_file`. `encoding` selects
 * how `content` is interpreted upstream — `base64` for binary payloads.
 * Non-throwing: a failed write comes back as `{ error }`.
 */
export async function writeSandboxFile(
  bridge: Pick<SandboxBridge, 'writeFile'>,
  sandboxPath: string,
  content: string,
  encoding: 'utf8' | 'base64',
): Promise<{ ok: true } | { error: string }> {
  const write = readSandboxResult(
    await bridge.writeFile.invoke({ path: sandboxPath, content, encoding }),
  );
  if (!write.ok) {
    return {
      error: `Couldn't write \`${sandboxPath}\` in the sandbox: ${truncate(write.text)}`,
    };
  }
  return { ok: true };
}
