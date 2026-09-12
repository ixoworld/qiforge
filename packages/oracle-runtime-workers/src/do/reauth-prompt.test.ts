import { describe, expect, it, vi } from 'vitest';
import { ReauthPrompter } from './reauth-prompt';

const transient = () => new Error('Durable Object reset');
const HOUR = 3_600_000;

function harness(
  opts: { send?: () => Promise<string>; now?: () => number } = {},
) {
  let stamp: number | undefined;
  const send = vi.fn(opts.send ?? (async () => '$ev'));
  const kept: Promise<unknown>[] = [];
  const warn = vi.fn();
  const log = vi.fn();
  const prompter = new ReauthPrompter({
    throttleMs: 6 * HOUR,
    getStamp: async () => stamp,
    setStamp: async (at) => {
      stamp = at;
    },
    send,
    keepAlive: (w) => kept.push(w),
    log,
    warn,
    now: opts.now,
    retry: { delaysMs: [1, 1, 1], sleep: async () => undefined },
  });
  return { prompter, send, warn, log, kept, stamp: () => stamp };
}

describe('ReauthPrompter', () => {
  it('sends and stamps the throttle only after the send succeeded', async () => {
    let now = 1_000_000;
    const { prompter, send, stamp, kept } = harness({ now: () => now });
    await prompter.prompt('did:u', '!room');
    expect(send).toHaveBeenCalledOnce();
    expect(stamp()).toBe(now);
    expect(kept).toHaveLength(1);
    now += HOUR; // inside the window: no second prompt
    await prompter.prompt('did:u', '!room');
    expect(send).toHaveBeenCalledOnce();
    now += 6 * HOUR; // window over: prompts again
    await prompter.prompt('did:u', '!room');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('leaves the throttle unstamped when the send fails, so the next message prompts again', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('M_FORBIDDEN'))
      .mockResolvedValue('$ev');
    const { prompter, stamp, warn } = harness({ send });
    await prompter.prompt('did:u', '!room');
    expect(stamp()).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    await prompter.prompt('did:u', '!room');
    expect(send).toHaveBeenCalledTimes(2);
    expect(stamp()).toBeDefined();
  });

  it('retries a transient gateway failure and stamps once the event is accepted', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValue('$ev');
    const { prompter, stamp, warn } = harness({ send });
    await prompter.prompt('did:u', '!room');
    expect(send).toHaveBeenCalledTimes(3);
    expect(stamp()).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('joins a prompt already in flight instead of posting a second one', async () => {
    let release!: (id: string) => void;
    const gate = new Promise<string>((r) => {
      release = r;
    });
    const send = vi.fn(() => gate);
    const { prompter } = harness({ send });
    const a = prompter.prompt('did:u', '!room');
    const b = prompter.prompt('did:u', '!room');
    expect(b).toBe(a);
    release('$ev');
    await Promise.all([a, b]);
    expect(send).toHaveBeenCalledOnce();
    // Settled: a later call (past the throttle) is a new attempt.
    expect((prompter as unknown as { inFlight: unknown }).inFlight).toBeNull();
  });
});
