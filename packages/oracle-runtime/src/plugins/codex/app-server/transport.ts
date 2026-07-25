import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Byte pipe to an App Server instance. Framing (newline-delimited JSON) is the
 * transport's concern; the client above it deals only in decoded frames.
 */
export interface CodexTransport {
  send(frame: unknown): void;
  onMessage(handler: (frame: unknown) => void): void;
  /** Fired once when the pipe closes, for any reason. */
  onClose(
    handler: (info: { code: number | null; detail?: string }) => void,
  ): void;
  close(): Promise<void>;
}

export interface StdioTransportOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  /** Spread over the inherited env. Contains credential material. */
  env: Readonly<Record<string, string>>;
  /** Receives the child's stderr, line by line. */
  onStderr?: (line: string) => void;
}

export class CodexTransportError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(`codex: ${message}`);
    this.name = 'CodexTransportError';
  }
}

/** Split a growing buffer into complete lines, returning the remainder. */
export function drainLines(buffer: string): {
  lines: string[];
  rest: string;
} {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.filter((line) => line.trim().length > 0), rest };
}

/**
 * Spawns `codex app-server` and speaks newline-delimited JSON over its stdio.
 * The default transport; `CodexAppServerClient` accepts any `CodexTransport`
 * so a WebSocket-hosted App Server can be swapped in without touching the
 * client.
 */
export class StdioCodexTransport implements CodexTransport {
  private child: ChildProcessWithoutNullStreams | null = null;

  private stdoutBuffer = '';

  private stderrBuffer = '';

  private messageHandler: ((frame: unknown) => void) | null = null;

  private closeHandler:
    | ((info: { code: number | null; detail?: string }) => void)
    | null = null;

  private closed = false;

  constructor(private readonly options: StdioTransportOptions) {}

  start(): void {
    if (this.child) throw new CodexTransportError('transport already started');

    try {
      this.child = spawn(this.options.command, [...this.options.args], {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new CodexTransportError(
        `failed to spawn '${this.options.command}'`,
        error,
      );
    }

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      const { lines, rest } = drainLines(this.stdoutBuffer);
      this.stdoutBuffer = rest;
      for (const line of lines) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(line);
        } catch {
          // Non-JSON on stdout is diagnostic noise from the binary, not a
          // protocol frame. Surface it through the stderr channel instead of
          // tearing down a working connection.
          this.options.onStderr?.(line);
          continue;
        }
        this.messageHandler?.(decoded);
      }
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk;
      const { lines, rest } = drainLines(this.stderrBuffer);
      this.stderrBuffer = rest;
      for (const line of lines) this.options.onStderr?.(line);
    });

    const fail = (detail: string) => (code: number | null) => {
      if (this.closed) return;
      this.closed = true;
      this.closeHandler?.({ code, detail });
    };

    this.child.on('exit', (code) => fail('app server exited')(code));
    this.child.on('error', (error) => {
      if (this.closed) return;
      this.closed = true;
      this.closeHandler?.({ code: null, detail: error.message });
    });
  }

  send(frame: unknown): void {
    if (!this.child || this.closed) {
      throw new CodexTransportError('transport is not open');
    }
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  onMessage(handler: (frame: unknown) => void): void {
    this.messageHandler = handler;
  }

  onClose(
    handler: (info: { code: number | null; detail?: string }) => void,
  ): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child || this.closed) {
      this.closed = true;
      return;
    }
    this.closed = true;
    await new Promise<void>((resolveClose) => {
      const done = () => resolveClose();
      child.once('exit', done);
      child.stdin.end();
      child.kill('SIGTERM');
      // The binary flushes and exits on SIGTERM; escalate only if it doesn't.
      const escalate = setTimeout(() => {
        child.kill('SIGKILL');
        resolveClose();
      }, 5_000);
      escalate.unref?.();
      child.once('exit', () => clearTimeout(escalate));
    });
    this.child = null;
  }
}
