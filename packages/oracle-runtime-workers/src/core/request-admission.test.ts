import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  RequestAdmissionError,
  admissionConfig,
  admitRequest,
  admissionMetadata,
} from './request-admission';
import { makePlugin, makeBuildCtx, makeRunConfig } from './test-fixtures';
import { buildRuntimeContext, createNoopAmbient } from './runtime-context';
import { MiddlewareRegistry } from './registries';
import type { RequestAdmissionContext } from '../plugin-api/request-admission';

function context(did: string): Omit<RequestAdmissionContext, 'config'> {
  return {
    user: { did, matrixUserId: '', ucanDelegation: { raw: '' } },
    session: { id: did, requestId: did, client: 'portal' },
    message: '/status',
    signal: new AbortController().signal,
  };
}

const options = { env: {}, timeoutMs: 1_000, warn: () => undefined };

describe('request admission', () => {
  it('isolates concurrent users and stops after the first handler', async () => {
    const fallback = vi.fn(() => ({ kind: 'pass' as const }));
    const plugins = [
      makePlugin({
        name: 'read',
        getRequestAdmission: async (ctx) => ({
          kind: 'handled',
          text: ctx.user.did,
          title: 'Status',
        }),
      }),
      makePlugin({ name: 'fallback', getRequestAdmission: fallback }),
    ];
    const results = await Promise.all(
      ['alice', 'bob'].map((did) =>
        admitRequest(plugins, context(did), options),
      ),
    );
    expect(results).toEqual([
      { kind: 'handled', text: 'alice', title: 'Status' },
      { kind: 'handled', text: 'bob', title: 'Status' },
    ]);
    expect(fallback).not.toHaveBeenCalled();
  });
  it('does not turn a denied read into agent fallback', async () => {
    await expect(
      admitRequest(
        [
          makePlugin({
            name: 'read',
            getRequestAdmission: () => {
              throw new Error('denied');
            },
          }),
        ],
        context('alice'),
        options,
      ),
    ).rejects.toThrow(RequestAdmissionError);
  });
  it('rejects late success after cancellation', async () => {
    const abort = new AbortController();
    await expect(
      admitRequest(
        [
          makePlugin({
            name: 'read',
            getRequestAdmission: () => {
              abort.abort(new Error('cancelled'));
              return { kind: 'handled', text: 'Status', title: 'Status' };
            },
          }),
        ],
        { ...context('alice'), signal: abort.signal },
        options,
      ),
    ).rejects.toThrow('cancelled');
  });
  it('treats a handler that exceeds its time limit as pass and asks the next one', async () => {
    const warn = vi.fn();
    const seen: AbortSignal[] = [];
    const result = await admitRequest(
      [
        makePlugin({
          name: 'slow',
          getRequestAdmission: (ctx) => {
            seen.push(ctx.signal);
            return new Promise(() => undefined);
          },
        }),
        makePlugin({
          name: 'fast',
          getRequestAdmission: () => ({
            kind: 'handled',
            text: 'Status',
            title: 'Status',
          }),
        }),
      ],
      context('alice'),
      { env: {}, timeoutMs: 20, warn },
    );
    expect(result).toEqual({
      kind: 'handled',
      text: 'Status',
      title: 'Status',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('slow timed out after 20 ms'),
    );
    expect(seen[0]?.aborted).toBe(true);
  });
  it('hands each handler its own config keys and no core credentials', async () => {
    const env = {
      ORACLE_DID: 'did:ixo:oracle',
      OPEN_ROUTER_API_KEY: 'sk-provider',
      MATRIX_ORACLE_ADMIN_PASSWORD: 'bot-password',
      MATRIX_RECOVERY_PHRASE: 'recovery',
      CLOUDFLARE_API_TOKEN: 'cf-token',
      STATUS_URL: 'https://status.example',
      OTHER_API_KEY: 'other-secret',
    };
    const seen = vi.fn(() => ({ kind: 'pass' as const }));
    const plugin = makePlugin({
      name: 'status',
      configSchema: z.object({ STATUS_URL: z.string() }),
      getRequestAdmission: seen,
    });
    await admitRequest([plugin], context('alice'), {
      env,
      timeoutMs: 1_000,
      warn: () => undefined,
    });
    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          ORACLE_DID: 'did:ixo:oracle',
          STATUS_URL: 'https://status.example',
        },
      }),
    );
    expect(admissionConfig(env, plugin)).not.toHaveProperty(
      'OPEN_ROUTER_API_KEY',
    );
  });
  it('bounds and validates optional metadata', () => {
    expect(admissionMetadata('{"flowId":"a"}')).toEqual({ flowId: 'a' });
    expect(admissionMetadata('[]')).toBeUndefined();
    expect(admissionMetadata('x'.repeat(16385))).toBeUndefined();
  });
  it('collects request middleware freshly without changing the boot cache', async () => {
    const registry = new MiddlewareRegistry();
    const hook = vi.fn(() => []);
    registry.register(
      makePlugin({ name: 'read', getRequestMiddlewares: hook }),
    );
    const first = buildRuntimeContext(makeRunConfig(), createNoopAmbient(), {
      messages: [],
      loadedPlugins: new Set(),
    });
    const second = buildRuntimeContext(makeRunConfig(), createNoopAmbient(), {
      messages: [],
      loadedPlugins: new Set(),
    });
    registry.collect(makeBuildCtx());
    await registry.collectRequest(first);
    await registry.collectRequest(second);
    expect(hook.mock.calls).toEqual([[first], [second]]);
  });
});
