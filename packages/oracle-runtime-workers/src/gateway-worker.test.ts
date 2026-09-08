import { describe, expect, it, vi } from 'vitest';
import type { OracleWorkerEnv } from './do/contracts';
import { createGatewayWorker } from './gateway-worker';

interface Fake {
  env: OracleWorkerEnv;
  ensureStarted: ReturnType<typeof vi.fn>;
  idFromName: ReturnType<typeof vi.fn>;
}

function fakeEnv(): Fake {
  const ensureStarted = vi.fn(async () => undefined);
  const idFromName = vi.fn((name: string) => ({ name }));
  const namespace = {
    idFromName,
    get: vi.fn(() => ({ ensureStarted })),
  };
  // Only the keys the gateway entry touches are populated; the type is the
  // full env because the DO class is declared against it.
  const env = {
    MATRIX_GATEWAY: namespace,
    ORACLE_DID: 'did:ixo:oracle',
  } as unknown as OracleWorkerEnv;
  return { env, ensureStarted, idFromName };
}

function ctx() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        promises.push(p);
      },
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext,
    promises,
  };
}

describe('createGatewayWorker', () => {
  it('exports the gateway class and nothing agent-side', () => {
    const worker = createGatewayWorker();
    expect(typeof worker.MatrixGatewayDO).toBe('function');
    expect(Object.keys(worker).sort()).toEqual([
      'MatrixGatewayDO',
      'fetch',
      'scheduled',
    ]);
  });

  it('answers /health, kicks the keep-alive in the background, 404s the rest', async () => {
    const worker = createGatewayWorker();
    const { env, ensureStarted, idFromName } = fakeEnv();
    const { ctx: c, promises } = ctx();

    const ok = await worker.fetch(
      new Request('https://gw.example/health'),
      env,
      c,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      ok: true,
      role: 'matrix-gateway',
      oracleDid: 'did:ixo:oracle',
    });
    await Promise.all(promises);
    expect(idFromName).toHaveBeenCalledWith('did:ixo:oracle');
    expect(ensureStarted).toHaveBeenCalledTimes(1);

    const missing = await worker.fetch(
      new Request('https://gw.example/matrix/status'),
      env,
      c,
    );
    expect(missing.status).toBe(404);
    const post = await worker.fetch(
      new Request('https://gw.example/health', { method: 'POST' }),
      env,
      c,
    );
    expect(post.status).toBe(404);
  });

  it('runs the keep-alive from the cron', async () => {
    const worker = createGatewayWorker();
    const { env, ensureStarted } = fakeEnv();
    await worker.scheduled(
      { cron: '*/5 * * * *', scheduledTime: 0, noRetry: () => undefined },
      env,
      ctx().ctx,
    );
    expect(ensureStarted).toHaveBeenCalledTimes(1);
  });
});
