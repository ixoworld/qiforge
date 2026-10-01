/**
 * Per-call timeout for upstream MCP tool invocations.
 *
 * Never hand the MCP SDK a tool timeout (`defaultToolTimeout` / `timeout`):
 * on workerd a client created with one leaves the user's Durable Object
 * resident after `close()` for the whole timeout window (measured: 47 s+ on
 * a minimal object; the oracle's 420 s memory timeout pinned it for 7 min
 * after every memory call), which blocks WebSocket hibernation and bills
 * duration. A plain race against a timer that is ALWAYS cleared has no such
 * effect. `onTimeout` lets the caller tear the client down so the abandoned
 * request cannot keep the object busy either.
 */
export class McpCallTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not complete within ${Math.round(ms / 1000)} s`);
    this.name = 'McpCallTimeoutError';
  }
}

export async function withCallTimeout<T>(
  run: () => Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void | Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void Promise.resolve(onTimeout?.()).catch(() => undefined);
      reject(new McpCallTimeoutError(label, ms));
    }, ms);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
