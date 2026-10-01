/* eslint-disable @typescript-eslint/no-explicit-any -- patching the global timer functions */
/**
 * Debug-only bookkeeping of the isolate's pending JavaScript timers.
 *
 * A Durable Object holding hibernatable WebSockets is only hibernated while
 * it is idle; a pending `setTimeout`/`setInterval` keeps it resident (and
 * billed). Finding the timer that pins an object means knowing which timers
 * exist — the platform offers no introspection, so with debug routes on the
 * object patches the four timer globals once per isolate and records every
 * live timer with its creation site. Read via `GET /debug/realtime`.
 */

export interface PendingTimer {
  id: number;
  kind: 'timeout' | 'interval';
  delayMs: number;
  ageMs: number;
  /** First frames of the creating stack, trimmed. */
  createdAt: string[];
}

interface TimerRecord {
  kind: 'timeout' | 'interval';
  delayMs: number;
  createdAtMs: number;
  stack: string[];
}

// Under `nodejs_compat` the timer globals return Node-style `Timeout`
// objects, not numbers — those cannot cross the RPC boundary, so every live
// timer is keyed by our own sequence number and the handle is kept aside.
const live = new Map<number, TimerRecord>();
const seqOfHandle = new Map<unknown, number>();
let seq = 0;
let installed = false;

function stackOf(): string[] {
  const raw = new Error().stack ?? '';
  return raw
    .split('\n')
    .slice(3, 9)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function track(
  kind: 'timeout' | 'interval',
  handle: unknown,
  delayMs: number,
): number {
  const id = ++seq;
  live.set(id, { kind, delayMs, createdAtMs: Date.now(), stack: stackOf() });
  seqOfHandle.set(handle, id);
  return id;
}

function untrack(handle: unknown): void {
  const id = seqOfHandle.get(handle);
  if (id === undefined) return;
  seqOfHandle.delete(handle);
  live.delete(id);
}

export function installTimerTracker(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as any;
  const origSetTimeout = g.setTimeout.bind(g);
  const origSetInterval = g.setInterval.bind(g);
  const origClearTimeout = g.clearTimeout.bind(g);
  const origClearInterval = g.clearInterval.bind(g);
  g.setTimeout = (
    fn: (...a: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const handle: unknown = origSetTimeout(
      (...a: unknown[]) => {
        untrack(handle);
        fn(...a);
      },
      delay,
      ...args,
    );
    track('timeout', handle, delay ?? 0);
    return handle;
  };
  g.setInterval = (
    fn: (...a: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const handle: unknown = origSetInterval(fn, delay, ...args);
    track('interval', handle, delay ?? 0);
    return handle;
  };
  g.clearTimeout = (handle?: unknown) => {
    if (handle !== undefined) untrack(handle);
    return origClearTimeout(handle);
  };
  g.clearInterval = (handle?: unknown) => {
    if (handle !== undefined) untrack(handle);
    return origClearInterval(handle);
  };
}

export function pendingTimers(): PendingTimer[] {
  const now = Date.now();
  return [...live.entries()].map(([id, t]) => ({
    id,
    kind: t.kind,
    delayMs: t.delayMs,
    ageMs: now - t.createdAtMs,
    createdAt: t.stack,
  }));
}

export function timerTrackerInstalled(): boolean {
  return installed;
}
