import { describe, expect, it, vi } from 'vitest';
import {
  isGateRefusal,
  platformModelsOf,
  runTurnGates,
  TURN_GATE_UNAVAILABLE,
  turnGatePlugins,
  turnRefusalResponse,
  validRefusal,
} from './turn-gate';
import { makePlugin, makeRunConfig } from './test-fixtures';
import { buildRuntimeContext, createNoopAmbient } from './runtime-context';
import type { TurnGateContext } from '../plugin-api/turn-gate';

function context(): Omit<TurnGateContext, 'signal'> {
  const { ucan, logger } = buildRuntimeContext(
    makeRunConfig(),
    createNoopAmbient(),
    { messages: [] },
  );
  return {
    trigger: 'portal',
    user: {
      did: 'did:ixo:alice',
      matrixUserId: '',
      ucanDelegation: { raw: '' },
    },
    session: { id: 's1', client: 'portal', requestId: 'r1' },
    hasAttachments: false,
    config: {},
    ucan,
    hasByoCredentials: async () => false,
    logger,
  };
}

function logs() {
  const lines: Array<{ level: string; line: string }> = [];
  return {
    lines,
    options: {
      requestId: 'r1',
      log: (level: 'info' | 'warn', line: string) =>
        lines.push({ level, line }),
    },
  };
}

const TOP_UP = { status: 402, code: 'credits_exhausted', message: 'Top up.' };

describe('turn gate', () => {
  it('lets a turn run when no plugin gates, building nothing', async () => {
    const plain = makePlugin({ name: 'plain' });
    expect(turnGatePlugins([plain])).toEqual([]);
    expect(await runTurnGates([], context(), logs().options)).toBeNull();
  });

  it('allows on { allow: true } and on undefined', async () => {
    const gated = turnGatePlugins([
      makePlugin({ name: 'a', gateTurn: () => ({ allow: true }) }),
      makePlugin({ name: 'b', gateTurn: async () => undefined }),
    ]);
    const { lines, options } = logs();
    expect(await runTurnGates(gated, context(), options)).toBeNull();
    expect(lines).toEqual([]);
  });

  it('refuses with the plugin refusal and logs one line without user data', async () => {
    const gated = turnGatePlugins([
      makePlugin({ name: 'billing', gateTurn: () => ({ refuse: TOP_UP }) }),
    ]);
    const { lines, options } = logs();
    const refused = await runTurnGates(gated, context(), options);
    expect(refused).toEqual({ plugin: 'billing', refusal: TOP_UP });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).toMatch(/^\[turn-gate\] refused /);
    expect(
      JSON.parse(lines[0]!.line.slice('[turn-gate] refused '.length)),
    ).toMatchObject({
      plugin: 'billing',
      trigger: 'portal',
      requestId: 'r1',
      status: 402,
      code: 'credits_exhausted',
    });
    expect(lines[0]!.line).not.toContain('alice');
  });

  it('composes in plugin order: the first refusal wins whatever finishes first, and later gates are aborted', async () => {
    let laterSignal: AbortSignal | undefined;
    const gated = turnGatePlugins([
      makePlugin({
        name: 'first',
        gateTurn: () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({ refuse: { status: 403, message: 'first says no' } }),
              30,
            ),
          ),
      }),
      makePlugin({
        name: 'second',
        gateTurn: (ctx) => {
          laterSignal = ctx.signal;
          return { refuse: { status: 402, message: 'second says no' } };
        },
      }),
      makePlugin({
        name: 'third',
        gateTurn: (ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener('abort', () => resolve(undefined));
          }),
      }),
    ]);
    const refused = await runTurnGates(gated, context(), logs().options);
    expect(refused).toMatchObject({
      plugin: 'first',
      refusal: { message: 'first says no' },
    });
    expect(laterSignal?.aborted).toBe(true);
  });

  it('composes allowances: one gate restricting to the person’s provider restricts the turn', async () => {
    const gated = turnGatePlugins([
      makePlugin({ name: 'open', gateTurn: () => ({ allow: true }) }),
      makePlugin({
        name: 'billing',
        gateTurn: () => ({ allow: true, platformModels: 'deny' }),
      }),
      makePlugin({
        name: 'explicit',
        gateTurn: () => ({ allow: true, platformModels: 'allow' }),
      }),
    ]);
    const { lines, options } = logs();
    const verdict = await runTurnGates(gated, context(), options);
    expect(verdict).toEqual({ platformModels: 'deny', plugins: ['billing'] });
    expect(isGateRefusal(verdict)).toBe(false);
    expect(platformModelsOf(verdict)).toBe('deny');
    expect(platformModelsOf(null)).toBe('allow');
    expect(lines).toEqual([]);
  });

  it('a refusal beats a restriction, whatever the order', async () => {
    const gated = turnGatePlugins([
      makePlugin({
        name: 'billing',
        gateTurn: () => ({ allow: true, platformModels: 'deny' }),
      }),
      makePlugin({ name: 'quota', gateTurn: () => ({ refuse: TOP_UP }) }),
    ]);
    const verdict = await runTurnGates(gated, context(), logs().options);
    expect(isGateRefusal(verdict)).toBe(true);
    expect(verdict).toEqual({ plugin: 'quota', refusal: TOP_UP });
  });

  it('an unknown platformModels value is a failure of the gate (open: no restriction)', async () => {
    const gated = turnGatePlugins([
      makePlugin({
        name: 'odd',
        // An answer from untyped plugin code.
        gateTurn: () => JSON.parse('{"allow":true,"platformModels":"maybe"}'),
      }),
    ]);
    const { lines, options } = logs();
    expect(await runTurnGates(gated, context(), options)).toBeNull();
    expect(lines[0]!.line).toContain(
      "platformModels must be 'allow' or 'deny'",
    );
  });

  it('answers a refusal status outside 402/403/429/503 as 403, logged', async () => {
    for (const [status, answered] of [
      [402, 402],
      [403, 403],
      [429, 429],
      [503, 503],
      [400, 403],
      [404, 403],
      [500, 403],
    ] as const) {
      const gated = turnGatePlugins([
        makePlugin({
          name: 'odd',
          gateTurn: () => ({ refuse: { status, message: 'No.' } }),
        }),
      ]);
      const { lines, options } = logs();
      const verdict = await runTurnGates(gated, context(), options);
      expect(verdict).toEqual({
        plugin: 'odd',
        refusal: { status: answered, message: 'No.' },
      });
      const coerced = lines.filter((l) => l.line.includes('answeredAs'));
      expect(coerced).toHaveLength(status === answered ? 0 : 1);
    }
  });

  it('asks every gate concurrently: latency is the slowest gate, not the sum', async () => {
    const started: number[] = [];
    const slow = (name: string) =>
      makePlugin({
        name,
        gateTurn: async () => {
          started.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, 50));
          return undefined;
        },
      });
    const gated = turnGatePlugins([slow('a'), slow('b'), slow('c')]);
    const t0 = Date.now();
    expect(await runTurnGates(gated, context(), logs().options)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(140);
    expect(Math.max(...started) - Math.min(...started)).toBeLessThan(20);
  });

  it.each([
    { onFailure: undefined, expected: null },
    { onFailure: 'open' as const, expected: null },
    {
      onFailure: 'closed' as const,
      expected: { plugin: 'slow', refusal: TURN_GATE_UNAVAILABLE },
    },
  ])(
    'a gate past its time limit fails $onFailure (default open)',
    async ({ onFailure, expected }) => {
      vi.useFakeTimers();
      try {
        let signal: AbortSignal | undefined;
        const gated = turnGatePlugins([
          makePlugin({
            name: 'slow',
            turnGate: { timeoutMs: 200, ...(onFailure ? { onFailure } : {}) },
            gateTurn: (ctx) => {
              signal = ctx.signal;
              return new Promise(() => undefined);
            },
          }),
        ]);
        const { lines, options } = logs();
        const pending = runTurnGates(gated, context(), options);
        await vi.advanceTimersByTimeAsync(199);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toEqual(expected);
        expect(signal?.aborted).toBe(true);
        expect(lines[0]).toMatchObject({ level: 'warn' });
        expect(lines[0]!.line).toContain('timed out after 200 ms');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('uses a 1 s default limit and caps a declared one at 10 s', async () => {
    vi.useFakeTimers();
    try {
      const never = () => new Promise<undefined>(() => undefined);
      const { lines, options } = logs();
      const byDefault = runTurnGates(
        turnGatePlugins([makePlugin({ name: 'd', gateTurn: never })]),
        context(),
        options,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await byDefault).toBeNull();
      const capped = runTurnGates(
        turnGatePlugins([
          makePlugin({
            name: 'c',
            turnGate: { timeoutMs: 60_000 },
            gateTurn: never,
          }),
        ]),
        context(),
        options,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await capped).toBeNull();
      expect(lines.map((l) => l.line).join('\n')).toMatch(
        /timed out after 1000 ms[\s\S]*timed out after 10000 ms/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolates a throwing gate: open lets the turn run, closed refuses 503', async () => {
    const boom = () => {
      throw new Error('kv unavailable');
    };
    const open = await runTurnGates(
      turnGatePlugins([makePlugin({ name: 'open', gateTurn: boom })]),
      context(),
      logs().options,
    );
    expect(open).toBeNull();
    const { lines, options } = logs();
    const closed = await runTurnGates(
      turnGatePlugins([
        makePlugin({
          name: 'closed',
          turnGate: { onFailure: 'closed' },
          gateTurn: boom,
        }),
      ]),
      context(),
      options,
    );
    expect(closed).toEqual({
      plugin: 'closed',
      refusal: TURN_GATE_UNAVAILABLE,
    });
    expect(lines[0]!.line).toContain('threw: kv unavailable');
  });

  it('treats an invalid refusal as a failure of the gate', async () => {
    const { lines, options } = logs();
    const refused = await runTurnGates(
      turnGatePlugins([
        makePlugin({
          name: 'bad',
          gateTurn: () => ({ refuse: { status: 200, message: 'ok?' } }),
        }),
      ]),
      context(),
      options,
    );
    expect(refused).toBeNull();
    expect(lines[0]!.line).toContain('invalid refusal: status must be');
  });

  it('checks a refusal: status range, message, code, details size', () => {
    expect(validRefusal({ status: 402, message: 'Top up.' })).toEqual({
      status: 402,
      message: 'Top up.',
    });
    expect(validRefusal({ status: 399, message: 'x' })).toMatch(/status/);
    expect(validRefusal({ status: 600, message: 'x' })).toMatch(/status/);
    expect(validRefusal({ status: 402.5, message: 'x' })).toMatch(/status/);
    expect(validRefusal({ status: 402, message: '  ' })).toMatch(/message/);
    expect(validRefusal({ status: 402, message: 'x'.repeat(2_001) })).toMatch(
      /message/,
    );
    expect(
      validRefusal({ status: 402, message: 'x', code: 'Bad-Code' }),
    ).toMatch(/code/);
    expect(
      validRefusal({
        status: 402,
        message: 'x',
        details: { topUpUrl: 'https://example.org/top-up' },
      }),
    ).toEqual({
      status: 402,
      message: 'x',
      details: { topUpUrl: 'https://example.org/top-up' },
    });
    expect(
      validRefusal({
        status: 402,
        message: 'x',
        details: { big: 'y'.repeat(5_000) },
      }),
    ).toMatch(/details/);
  });

  it('keeps a valid action and retry delay, and drops (and notes) invalid ones without invalidating the refusal', () => {
    const dropped: string[] = [];
    expect(
      validRefusal(
        {
          status: 402,
          message: 'x',
          details: {
            retryAfterSeconds: 59.2,
            action: { label: ' Top up credits ', url: 'https://p.example/t' },
            topUpUrl: 'https://p.example/t',
          },
        },
        dropped,
      ),
    ).toEqual({
      status: 402,
      message: 'x',
      details: {
        retryAfterSeconds: 60,
        action: { label: 'Top up credits', url: 'https://p.example/t' },
        topUpUrl: 'https://p.example/t',
      },
    });
    expect(dropped).toEqual([]);
    const bad = (details: Record<string, unknown>) => {
      const notes: string[] = [];
      const checked = validRefusal(
        { status: 402, message: 'x', details },
        notes,
      );
      return { checked, notes };
    };
    for (const action of [
      { label: 'Top up', url: 'http://p.example/t' },
      { label: 'Top up', url: 'javascript:alert(1)' },
      { label: 'Top up', url: '/relative' },
      { label: 'x'.repeat(41), url: 'https://p.example/t' },
      { label: '   ', url: 'https://p.example/t' },
      'https://p.example/t',
    ]) {
      const { checked, notes } = bad({ action });
      expect(checked).toEqual({ status: 402, message: 'x', details: {} });
      expect(notes).toEqual([expect.stringMatching(/^details\.action /)]);
    }
    for (const retryAfterSeconds of [0, -5, 86_401, Number.NaN, '60']) {
      const { checked, notes } = bad({ retryAfterSeconds });
      expect(checked).toEqual({ status: 402, message: 'x', details: {} });
      expect(notes).toEqual([
        expect.stringMatching(/^details\.retryAfterSeconds /),
      ]);
    }
    // A 40-character label is fine.
    expect(
      bad({ action: { label: 'x'.repeat(40), url: 'https://p.example' } })
        .notes,
    ).toEqual([]);
  });

  it('logs a dropped action once and still refuses', async () => {
    const { lines, options } = logs();
    const refused = await runTurnGates(
      turnGatePlugins([
        makePlugin({
          name: 'billing',
          gateTurn: () => ({
            refuse: {
              ...TOP_UP,
              details: { action: { label: 'Top up', url: 'http://insecure' } },
            },
          }),
        }),
      ]),
      context(),
      options,
    );
    expect(refused).toMatchObject({
      plugin: 'billing',
      refusal: { status: 402, details: {} },
    });
    expect(lines.map((l) => l.line)).toEqual([
      expect.stringContaining('"dropped":"details.action url must be https"'),
      expect.stringContaining('[turn-gate] refused'),
    ]);
  });

  it('adds Retry-After to a Portal refusal that carries retryAfterSeconds', async () => {
    const response = turnRefusalResponse(
      {
        status: 503,
        code: 'credits_check_unavailable',
        message: 'Try again in a minute.',
        details: { retryAfterSeconds: 60 },
      },
      'req-2',
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toEqual({
      statusCode: 503,
      message: 'Try again in a minute.',
      code: 'credits_check_unavailable',
      details: { retryAfterSeconds: 60 },
      requestId: 'req-2',
      refused: true,
    });
  });

  it('answers a Portal refusal with its status and the usual error body', async () => {
    const response = turnRefusalResponse(
      { ...TOP_UP, details: { topUpUrl: 'https://example.org' } },
      'req-1',
    );
    expect(response.status).toBe(402);
    expect(response.headers.get('x-request-id')).toBe('req-1');
    expect(response.headers.get('retry-after')).toBeNull();
    expect(await response.json()).toEqual({
      statusCode: 402,
      message: 'Top up.',
      code: 'credits_exhausted',
      details: { topUpUrl: 'https://example.org' },
      requestId: 'req-1',
      refused: true,
    });
  });

  it('marks a refused 403 as a gate refusal, not an auth failure, even without a code', async () => {
    const response = turnRefusalResponse(
      { status: 403, message: 'This account cannot use this oracle.' },
      'req-3',
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      statusCode: 403,
      message: 'This account cannot use this oracle.',
      requestId: 'req-3',
      refused: true,
    });
  });

  it('aborts every gate when the request goes away', async () => {
    const request = new AbortController();
    let seen: AbortSignal | undefined;
    const pending = runTurnGates(
      turnGatePlugins([
        makePlugin({
          name: 'waits',
          gateTurn: (ctx) => {
            seen = ctx.signal;
            return new Promise((resolve) =>
              ctx.signal.addEventListener('abort', () => resolve(undefined)),
            );
          },
        }),
      ]),
      context(),
      { ...logs().options, signal: request.signal },
    );
    request.abort();
    expect(await pending).toBeNull();
    expect(seen?.aborted).toBe(true);
  });
});
