import { describe, expect, it } from 'vitest';
import {
  CallIdCollisionError,
  MAX_CALL_ID_LENGTH,
  shortCallId,
  shortenCallIds,
} from './byo-call-ids';

const LONG = `call_${'a'.repeat(67)}`;

function body(input: unknown[]): string {
  return JSON.stringify({ model: 'gpt-5.6-terra', input });
}

function callIds(shortened: string): string[] {
  const parsed: { input: Array<{ call_id?: string }> } = JSON.parse(shortened);
  return parsed.input.flatMap((item) =>
    item.call_id === undefined ? [] : [item.call_id],
  );
}

describe('shortCallId', () => {
  it('is within the limit, stable, and distinct per original', async () => {
    const a = await shortCallId(LONG);
    expect(LONG).toHaveLength(72);
    expect(a.length).toBeLessThanOrEqual(MAX_CALL_ID_LENGTH);
    expect(await shortCallId(LONG)).toBe(a);
    expect(await shortCallId(`${LONG}x`)).not.toBe(a);
    expect(a).toMatch(/^call_[A-Za-z0-9_-]{43}$/);
  });
});

describe('shortenCallIds', () => {
  it('replaces an over-long id in a call and its output alike, leaving the rest', async () => {
    const out = await shortenCallIds(
      body([
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'function_call', call_id: LONG, name: 't', arguments: '{}' },
        { type: 'function_call_output', call_id: LONG, output: 'ok' },
        {
          type: 'function_call',
          call_id: 'call_short',
          name: 't',
          arguments: '{}',
        },
      ]),
    );
    const ids = callIds(out);
    expect(ids[0]).toBe(await shortCallId(LONG));
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).toBe('call_short');
    expect(ids.every((id) => id.length <= MAX_CALL_ID_LENGTH)).toBe(true);
  });

  it('gives two different over-long ids two different ids, the same each time', async () => {
    const other = `${LONG}-2`;
    const request = body([
      { type: 'function_call', call_id: LONG, name: 't', arguments: '{}' },
      { type: 'function_call', call_id: other, name: 't', arguments: '{}' },
    ]);
    const first = callIds(await shortenCallIds(request));
    expect(new Set(first).size).toBe(2);
    expect(callIds(await shortenCallIds(request))).toEqual(first);
  });

  it('returns a body with nothing to shorten, or that is not a Responses body, as it came', async () => {
    const fine = body([{ type: 'function_call', call_id: 'call_ok' }]);
    expect(await shortenCallIds(fine)).toBe(fine);
    expect(await shortenCallIds('not json')).toBe('not json');
    expect(await shortenCallIds('{"messages":[]}')).toBe('{"messages":[]}');
  });

  it('refuses a request in which the replacement is another call’s id', async () => {
    const taken = await shortCallId(LONG);
    await expect(
      shortenCallIds(
        body([
          { type: 'function_call', call_id: LONG },
          { type: 'function_call', call_id: taken },
        ]),
      ),
    ).rejects.toBeInstanceOf(CallIdCollisionError);
  });
});
