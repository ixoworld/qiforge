import { RouterEvent } from '@ixo/oracles-events';
import { classifyLlmError } from '../../llm/provider-error.js';
import type { Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeResponse } from './__test-fixtures__/fake-response.js';
import {
  emitSSEEvent,
  formatSSE,
  getSSEContext,
  getSSEabortController,
  isSSEAborted,
  runWithSSEContext,
  sendSSEDone,
  sendSSEError,
  sendSSEHeartbeat,
  setSSEHeaders,
  startSSEHeartbeat,
} from './sse.utils.js';

function makeRouterEvent(step = 'initial'): RouterEvent {
  return new RouterEvent({
    connectionId: 'conn-1',
    sessionId: 'sess-1',
    requestId: 'req-1',
    step,
  });
}

describe('formatSSE', () => {
  it('emits "event: <name>\\ndata: <json>\\n\\n"', () => {
    const out = formatSSE('message', { hello: 'world' });
    expect(out).toBe('event: message\ndata: {"hello":"world"}\n\n');
  });
});

describe('setSSEHeaders', () => {
  it('includes X-Request-Id + Access-Control-Expose-Headers when requestId given', () => {
    const res = new FakeResponse();
    setSSEHeaders(res as unknown as Response, 'req-42');
    expect(res.setHeaders['Content-Type']).toBe('text/event-stream');
    expect(res.setHeaders['Cache-Control']).toBe('no-cache, no-transform');
    expect(res.setHeaders.Connection).toBe('keep-alive');
    expect(res.setHeaders['X-Accel-Buffering']).toBe('no');
    expect(res.setHeaders['X-Request-Id']).toBe('req-42');
    expect(res.setHeaders['Access-Control-Expose-Headers']).toBe(
      'X-Request-Id',
    );
  });

  it('omits X-Request-Id when requestId absent', () => {
    const res = new FakeResponse();
    setSSEHeaders(res as unknown as Response);
    expect(res.setHeaders['Content-Type']).toBe('text/event-stream');
    expect(res.setHeaders['X-Request-Id']).toBeUndefined();
    expect(res.setHeaders['Access-Control-Expose-Headers']).toBeUndefined();
  });
});

describe('heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("startSSEHeartbeat sends ': heartbeat\\n\\n' every 15s", () => {
    const res = new FakeResponse();
    const timer = startSSEHeartbeat(res as unknown as Response);

    vi.advanceTimersByTime(15_000);
    expect(res.writes).toEqual([': heartbeat\n\n']);

    vi.advanceTimersByTime(15_000);
    expect(res.writes).toEqual([': heartbeat\n\n', ': heartbeat\n\n']);

    clearInterval(timer);
  });

  it('sendSSEHeartbeat is a no-op when res.writableEnded', () => {
    const res = new FakeResponse();
    res.end();
    sendSSEHeartbeat(res as unknown as Response);
    expect(res.writes).toEqual([]);
  });

  it('clearInterval(returned) stops further writes', () => {
    const res = new FakeResponse();
    const timer = startSSEHeartbeat(res as unknown as Response);

    vi.advanceTimersByTime(15_000);
    expect(res.writes).toHaveLength(1);

    clearInterval(timer);
    vi.advanceTimersByTime(60_000);
    expect(res.writes).toHaveLength(1);
  });
});

describe('sendSSEDone / sendSSEError', () => {
  it('both no-op when writableEnded', () => {
    const res = new FakeResponse();
    res.end();

    sendSSEDone(res as unknown as Response);
    sendSSEError(res as unknown as Response, 'oops');

    expect(res.writes).toEqual([]);
  });

  it('sendSSEError serializes Error.message vs string verbatim', () => {
    const errRes = new FakeResponse();
    sendSSEError(errRes as unknown as Response, new Error('boom'));
    const strRes = new FakeResponse();
    sendSSEError(strRes as unknown as Response, 'raw-string');

    expect(errRes.writes).toHaveLength(1);
    const errChunk = errRes.writes[0]!;
    expect(errChunk.startsWith('event: error\n')).toBe(true);
    const errPayload = JSON.parse(errChunk.split('data: ')[1]!.trim()) as {
      error: string;
      timestamp: string;
    };
    expect(errPayload.error).toBe('boom');
    expect(typeof errPayload.timestamp).toBe('string');

    expect(strRes.writes).toHaveLength(1);
    const strPayload = JSON.parse(
      strRes.writes[0]!.split('data: ')[1]!.trim(),
    ) as {
      error: string;
    };
    expect(strPayload.error).toBe('raw-string');
  });

  it('redacts an operator-account failure on the way to the wire', () => {
    const outOfCredit = Object.assign(
      new Error(
        '402 This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.',
      ),
      { status: 402 },
    );
    const res = new FakeResponse();

    sendSSEError(
      res as unknown as Response,
      outOfCredit,
      classifyLlmError(outOfCredit),
      { sessionId: 'sess-1', requestId: 'req-1' },
    );

    const chunk = res.writes[0]!;
    const payload = JSON.parse(chunk.split('data: ')[1]!.trim()) as {
      error: string;
      kind: string;
      status: number;
      retryable: boolean;
      detail: string;
      sessionId: string;
    };
    expect(payload.kind).toBe('unknown');
    expect(payload.status).toBe(500);
    expect(payload.retryable).toBe(false);
    expect(payload.error).toBe(
      'Something went wrong while generating the reply. Please try again.',
    );
    expect(payload.detail).toBe(payload.error);
    // Identity still rides along — only the diagnosis is withheld.
    expect(payload.sessionId).toBe('sess-1');
    expect(chunk).not.toMatch(/credits/i);
  });

  it("keeps a BYO account's own billing failure actionable", () => {
    const insufficient = Object.assign(new Error('402 Insufficient Balance'), {
      status: 402,
    });
    const res = new FakeResponse();

    sendSSEError(
      res as unknown as Response,
      insufficient,
      classifyLlmError(insufficient, { byoProvider: 'deepseek' }),
    );

    const payload = JSON.parse(res.writes[0]!.split('data: ')[1]!.trim()) as {
      error: string;
      kind: string;
      source: string;
      provider: string;
    };
    expect(payload.kind).toBe('billing');
    expect(payload.source).toBe('byo');
    expect(payload.provider).toBe('deepseek');
    expect(payload.error).toMatch(/out of credit/i);
  });
});

describe('AsyncLocalStorage context', () => {
  it('runWithSSEContext binds res + abortController for the callback duration', async () => {
    const res = new FakeResponse();
    const abortController = new AbortController();
    let observedRes: Response | undefined;
    let observedCtrl: AbortController | undefined;

    await runWithSSEContext(
      res as unknown as Response,
      async () => {
        observedRes = getSSEContext();
        observedCtrl = getSSEabortController();
      },
      abortController,
    );

    expect(observedRes).toBe(res);
    expect(observedCtrl).toBe(abortController);
  });

  it('getSSEContext returns the bound res, undefined outside the callback', async () => {
    expect(getSSEContext()).toBeUndefined();

    const res = new FakeResponse();
    await runWithSSEContext(res as unknown as Response, async () => {
      expect(getSSEContext()).toBe(res);
    });

    expect(getSSEContext()).toBeUndefined();
  });

  it('emitSSEEvent writes through bound res; no-op when no context', async () => {
    const outOfContextRes = new FakeResponse();
    emitSSEEvent(makeRouterEvent());
    expect(outOfContextRes.writes).toEqual([]);

    const res = new FakeResponse();
    const event = makeRouterEvent('inside');

    await runWithSSEContext(res as unknown as Response, async () => {
      emitSSEEvent(event);
    });

    expect(res.writes).toHaveLength(1);
    const chunk = res.writes[0]!;
    expect(chunk.startsWith(`event: ${event.eventName}\n`)).toBe(true);
    const data = JSON.parse(chunk.split('data: ')[1]!.trim()) as {
      step: string;
      sessionId: string;
    };
    expect(data.step).toBe('inside');
    expect(data.sessionId).toBe('sess-1');
  });

  it('isSSEAborted reflects abortController.signal.aborted', async () => {
    expect(isSSEAborted()).toBe(false);

    const res = new FakeResponse();
    const controller = new AbortController();

    await runWithSSEContext(
      res as unknown as Response,
      async () => {
        expect(isSSEAborted()).toBe(false);
        controller.abort();
        expect(isSSEAborted()).toBe(true);
      },
      controller,
    );

    const resNoCtrl = new FakeResponse();
    await runWithSSEContext(resNoCtrl as unknown as Response, async () => {
      expect(isSSEAborted()).toBe(false);
    });
  });
});
