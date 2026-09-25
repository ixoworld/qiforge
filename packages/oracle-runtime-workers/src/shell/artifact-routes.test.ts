import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { artifactIdFor } from '../artifacts/store';
import { createShell } from './app';

const ARTIFACT_ID = 'b'.repeat(32);

async function putShareCopy(artifactId: string): Promise<void> {
  await env.ARTIFACT_TEST.put(`art/${artifactId}`, new Uint8Array([1, 2, 3]), {
    customMetadata: { expiresAt: '2999-01-01T00:00:00.000Z' },
  });
}

describe('artefact routes in the shell', () => {
  it('serves the viewer page and the ciphertext to anyone, whatever CORS_ORIGIN says', async () => {
    const app = createShell();
    const bindings = {
      ARTIFACT_BUCKET: env.ARTIFACT_TEST,
      ORACLE_NAME: 'Qi',
      CORS_ORIGIN: 'https://portal.test',
    };
    const page = await app.request(`/a/${ARTIFACT_ID}`, {}, bindings);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');

    await putShareCopy(ARTIFACT_ID);
    const data = await app.request(
      `/a/${ARTIFACT_ID}/data`,
      { headers: { origin: 'https://viewer.qi.space' } },
      bindings,
    );
    expect(data.status).toBe(200);
    expect(data.headers.get('access-control-allow-origin')).toBe('*');
    expect(new Uint8Array(await data.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it('rate-limits the data route per client IP', async () => {
    const keys: string[] = [];
    const app = createShell();
    const bindings = {
      ARTIFACT_BUCKET: env.ARTIFACT_TEST,
      RATE_LIMIT: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: false };
        },
      },
    };
    const limited = await app.request(
      `/a/${ARTIFACT_ID}/data`,
      { headers: { 'cf-connecting-ip': '203.0.113.9' } },
      bindings,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get('access-control-allow-origin')).toBe('*');
    expect(keys).toEqual(['artifact:203.0.113.9']);
  });

  it('keeps the owner routes behind auth', async () => {
    const app = createShell();
    const artifactId = await artifactIdFor('run-1', 'call-1');
    for (const method of ['GET', 'DELETE']) {
      const res = await app.request(
        `/artifacts/${artifactId}`,
        { method },
        { ARTIFACT_BUCKET: env.ARTIFACT_TEST, ORACLE_DID: 'did:ixo:oracle' },
      );
      expect(res.status).toBe(401);
    }
  });
});
