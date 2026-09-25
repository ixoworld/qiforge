import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { artifactLink, artifactLinkConfig } from './config';
import { openArtifact } from './crypto';
import { artifactDataResponse, artifactPageResponse } from './routes';
import { artifactIdFor } from './store';
import type { ArtifactStoreTestDO } from './test-do';
import { VIEWER_SCRIPT, VIEWER_STYLE } from './viewer-page';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      ARTIFACT_STORE_TEST: DurableObjectNamespace<ArtifactStoreTestDO>;
      ARTIFACT_TEST: R2Bucket;
    }
  }
}

function stub(name: string) {
  return env.ARTIFACT_STORE_TEST.get(env.ARTIFACT_STORE_TEST.idFromName(name));
}

function keyOf(url: string): string {
  const key = new URLSearchParams(new URL(url).hash.slice(1)).get('k');
  if (!key) throw new Error(`no key in ${url}`);
  return key;
}

const CONTENT = '# Week plan\n\n| Item | Due |\n|---|---|\n| Deck | Wed |';

describe('ArtifactStore', () => {
  it('stores the canonical copy and an encrypted share copy that opens with the link key', async () => {
    const s = stub('artifacts-create');
    const artifactId = await artifactIdFor('run-1', 'call-1');
    const ref = await s.create({
      artifactId,
      title: 'Week plan',
      content: CONTENT,
    });
    expect(ref).toMatchObject({
      artifactId,
      title: 'Week plan',
      mime: 'text/markdown',
      bytes: new TextEncoder().encode(CONTENT).byteLength,
      expiresAt: '2026-10-25T09:00:00.000Z',
    });
    expect(ref.url.startsWith(`https://oracle.test/a/${artifactId}#k=`)).toBe(
      true,
    );

    const object = await env.ARTIFACT_TEST.get(`art/${artifactId}`);
    const sealed = new Uint8Array(await object!.arrayBuffer());
    expect(new TextDecoder().decode(sealed)).not.toContain('Week plan');
    expect(object!.customMetadata).toEqual({ expiresAt: ref.expiresAt });
    await expect(openArtifact(keyOf(ref.url), sealed)).resolves.toMatchObject({
      title: 'Week plan',
      content: CONTENT,
    });
  });

  it('is idempotent per id: the same link, one document', async () => {
    const s = stub('artifacts-idempotent');
    const artifactId = await artifactIdFor('run-2', 'call-1');
    const first = await s.create({ artifactId, title: 'Plan', content: 'one' });
    const again = await s.create({
      artifactId,
      title: 'Other',
      content: 'two',
    });
    expect(again).toEqual(first);
    expect((await s.get(artifactId))?.content).toBe('one');
  });

  it('re-uploads a share copy lost between the insert and the upload', async () => {
    const s = stub('artifacts-reupload');
    const artifactId = await artifactIdFor('run-3', 'call-1');
    const ref = await s.create({ artifactId, title: 'Plan', content: 'kept' });
    await s.forgetUpload(artifactId);
    expect(await env.ARTIFACT_TEST.get(`art/${artifactId}`)).toBeNull();
    expect(
      await s.create({ artifactId, title: 'Plan', content: 'kept' }),
    ).toEqual(ref);
    const object = await env.ARTIFACT_TEST.get(`art/${artifactId}`);
    await expect(
      openArtifact(keyOf(ref.url), new Uint8Array(await object!.arrayBuffer())),
    ).resolves.toMatchObject({ content: 'kept' });
  });

  it('revokes the share copy and keeps the canonical copy', async () => {
    const s = stub('artifacts-revoke');
    const artifactId = await artifactIdFor('run-4', 'call-1');
    await s.create({ artifactId, title: 'Plan', content: 'private' });
    expect(await s.revoke(artifactId)).toBe(true);
    expect(await env.ARTIFACT_TEST.get(`art/${artifactId}`)).toBeNull();
    expect(await s.get(artifactId)).toMatchObject({
      content: 'private',
      revoked: true,
    });
    expect(await s.revoke('0'.repeat(32))).toBe(false);
  });

  it("deletes a session's artefacts, share copies first, and leaves other sessions alone", async () => {
    const s = stub('artifacts-session-delete');
    const doomed = await artifactIdFor('run-7', 'call-1');
    const also = await artifactIdFor('run-7', 'call-2');
    const kept = await artifactIdFor('run-8', 'call-1');
    await s.create({
      artifactId: doomed,
      title: 'A',
      content: 'a',
      sessionId: 's-1',
    });
    await s.create({
      artifactId: also,
      title: 'B',
      content: 'b',
      sessionId: 's-1',
    });
    await s.create({
      artifactId: kept,
      title: 'C',
      content: 'c',
      sessionId: 's-2',
    });
    expect(await s.deleteForSession('s-1')).toBe(2);
    expect(await env.ARTIFACT_TEST.get(`art/${doomed}`)).toBeNull();
    expect(await env.ARTIFACT_TEST.get(`art/${also}`)).toBeNull();
    expect(await s.get(doomed)).toBeUndefined();
    expect(await env.ARTIFACT_TEST.get(`art/${kept}`)).not.toBeNull();
    expect(await s.get(kept)).toMatchObject({ content: 'c', revoked: false });
    expect(await s.deleteForSession('s-1')).toBe(0);
  });

  it('links through a shared viewer with the source and key in the fragment', async () => {
    const s = stub('artifacts-viewer');
    await s.configure({ viewerUrl: 'https://portal.qi.space/artefact?x=1#y' });
    const artifactId = await artifactIdFor('run-5', 'call-1');
    const ref = await s.create({ artifactId, title: 'Plan', content: 'x' });
    const url = new URL(ref.url);
    expect(`${url.origin}${url.pathname}${url.search}`).toBe(
      'https://portal.qi.space/artefact',
    );
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect(fragment.get('a')).toBe(`https://oracle.test/a/${artifactId}`);
    expect(fragment.get('k')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('artifact link config', () => {
  it('is off without a bucket or a usable public origin', () => {
    expect(
      artifactLinkConfig({ ORACLE_PUBLIC_URL: 'https://oracle.test' }),
    ).toBeNull();
    expect(
      artifactLinkConfig({
        ARTIFACT_BUCKET: env.ARTIFACT_TEST,
        ORACLE_PUBLIC_URL: 'ftp://x',
      }),
    ).toBeNull();
    expect(
      artifactLinkConfig({
        ARTIFACT_BUCKET: env.ARTIFACT_TEST,
        ORACLE_PUBLIC_URL: 'http://evil.test',
      }),
    ).toBeNull();
  });

  it('defaults links to 30 days and never lets them outlive a year', () => {
    const config = artifactLinkConfig({
      ARTIFACT_BUCKET: env.ARTIFACT_TEST,
      ORACLE_PUBLIC_URL: 'https://oracle.test/some/path',
    });
    expect(config?.publicUrl).toBe('https://oracle.test');
    expect(config?.ttlMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(
      artifactLinkConfig({
        ARTIFACT_BUCKET: env.ARTIFACT_TEST,
        ORACLE_PUBLIC_URL: 'https://oracle.test',
        ARTIFACT_LINK_TTL_DAYS: '100000',
      })?.ttlMs,
    ).toBe(365 * 24 * 60 * 60 * 1000);
    expect(
      artifactLink({ publicUrl: 'https://oracle.test' }, 'abc', 'k1'),
    ).toBe('https://oracle.test/a/abc#k=k1');
  });
});

describe('artifact routes', () => {
  it('serves ciphertext to any origin, and 410 once the link has expired', async () => {
    const s = stub('artifacts-routes');
    const artifactId = await artifactIdFor('run-6', 'call-1');
    const ref = await s.create({ artifactId, title: 'Plan', content: 'body' });
    const routeEnv = { ARTIFACT_BUCKET: env.ARTIFACT_TEST };

    const ok = await artifactDataResponse(
      routeEnv,
      artifactId,
      Date.parse('2026-10-01T00:00:00Z'),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('*');
    expect(ok.headers.get('cache-control')).toBe('private, max-age=60');
    await expect(
      openArtifact(keyOf(ref.url), new Uint8Array(await ok.arrayBuffer())),
    ).resolves.toMatchObject({ content: 'body' });

    const expired = await artifactDataResponse(
      routeEnv,
      artifactId,
      Date.parse('2026-10-26T00:00:00Z'),
    );
    expect(expired.status).toBe(410);
    expect(await env.ARTIFACT_TEST.get(`art/${artifactId}`)).toBeNull();
    expect((await artifactDataResponse(routeEnv, artifactId)).status).toBe(404);
    expect((await artifactDataResponse(routeEnv, 'not-an-id')).status).toBe(
      404,
    );
  });

  it('serves one static page that only runs its own script and style', async () => {
    const page = await artifactPageResponse(
      { ORACLE_NAME: 'Qi <Companion>', ARTIFACT_BUCKET: env.ARTIFACT_TEST },
      'a'.repeat(32),
    );
    expect(page.status).toBe(200);
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const html = await page.text();
    expect(html).toContain('Shared by Qi &lt;Companion&gt;');
    expect(html).toContain(`<script>${VIEWER_SCRIPT}</script>`);
    expect(html).toContain(`<style>${VIEWER_STYLE}</style>`);
    expect(html).not.toContain('innerHTML');
    expect(
      (
        await artifactPageResponse(
          { ORACLE_NAME: 'Qi', ARTIFACT_BUCKET: env.ARTIFACT_TEST },
          'nope',
        )
      ).status,
    ).toBe(404);
  });
});
