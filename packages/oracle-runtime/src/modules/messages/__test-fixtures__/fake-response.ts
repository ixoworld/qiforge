import { EventEmitter } from 'node:events';

/**
 * Structurally-typed `express.Response` test double. Captures every
 * `write` chunk into a buffer so tests can assert on the SSE wire
 * format directly. Inherits from `EventEmitter` so `res.on('close', …)`
 * registrations from the SUT can be triggered via `emit('close')`.
 *
 * Not declared as `implements Pick<Response, ...>` because Express's
 * method signatures return `Response<...>` (not `this`), which the
 * chainable methods here can't satisfy. The type contract lives at the
 * SUT injection site (`as unknown as Response`), where the partial-mock
 * intent is surface-visible.
 */
export class FakeResponse extends EventEmitter {
  public writes: string[] = [];
  public headersSent = false;
  public writableEnded = false;
  public setHeaders: Record<string, string> = {};
  public statusCode = 200;
  public jsonBody: unknown;

  set(field: Record<string, string>): this;
  set(field: string, value?: string | string[]): this;
  set(field: Record<string, string> | string, value?: string | string[]): this {
    if (typeof field === 'string') {
      if (value !== undefined) {
        this.setHeaders[field] = Array.isArray(value)
          ? value.join(', ')
          : value;
      }
      return this;
    }
    this.setHeaders = { ...this.setHeaders, ...field };
    return this;
  }

  flushHeaders(): void {
    this.headersSent = true;
  }

  write(chunk: string | Buffer): boolean {
    if (this.writableEnded) return false;
    this.writes.push(
      typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
    );
    return true;
  }

  end(): this {
    this.writableEnded = true;
    return this;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.jsonBody = body;
    this.writableEnded = true;
    return this;
  }
}
