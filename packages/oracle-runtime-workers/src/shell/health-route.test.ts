/**
 * `GET /health` is unauthenticated and advertises the frontend bridge
 * version. The Portal enables conversational Topic writes only when it reads
 * exactly these three values from the oracle's API origin.
 */
import { describe, expect, it } from 'vitest';
import { createShell } from './app';

describe('GET /health', () => {
  it('answers without auth and advertises the single-socket, unknown-outcome frontend bridge', async () => {
    const res = await createShell().request('/health', {}, {});
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({
      status: 'ok',
      timestamp: expect.any(String),
      frontendTools: {
        protocolVersion: 2,
        execution: 'single-socket',
        timeoutOutcome: 'unknown',
      },
    });
  });
});
