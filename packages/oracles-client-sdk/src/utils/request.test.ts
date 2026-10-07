import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, RequestError } from './request.js';

afterEach(() => vi.unstubAllGlobals());

const reply = (body: unknown, status: number) =>
  vi.fn(async () => Response.json(body, { status }));

describe('request', () => {
  it('copies the runtime’s machine-readable code and retry hint onto the error', async () => {
    vi.stubGlobal(
      'fetch',
      reply(
        {
          statusCode: 409,
          code: 'FEEDBACK_IN_FLIGHT',
          message: 'This feedback is being delivered',
          retryable: true,
        },
        409,
      ),
    );
    const error = await request('https://o/x', 'POST').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({
      status: 409,
      code: 'FEEDBACK_IN_FLIGHT',
      retryable: true,
      message: 'This feedback is being delivered',
    });
  });

  it('leaves code and retryable unset when the body has none, or has them in the wrong shape', async () => {
    vi.stubGlobal(
      'fetch',
      reply(
        { statusCode: 500, message: 'boom', code: 7, retryable: 'yes' },
        500,
      ),
    );
    const error = await request('https://o/x', 'GET').catch((e: unknown) => e);
    if (!(error instanceof RequestError)) throw error;
    expect(error.status).toBe(500);
    expect(error.code).toBeUndefined();
    expect(error.retryable).toBeUndefined();
  });

  it('takes the status from the response when the body does not repeat it', async () => {
    vi.stubGlobal(
      'fetch',
      reply({ message: 'A signed invocation is required.' }, 401),
    );
    const error = await request('https://o/x', 'GET').catch((e: unknown) => e);
    if (!(error instanceof RequestError)) throw error;
    expect(error.status).toBe(401);
  });
});
