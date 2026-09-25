/**
 * The public artefact routes. `GET /a/:id` is the same static page for every
 * artefact; `GET /a/:id/data` returns the ciphertext. Neither needs auth:
 * without the key in the link's fragment the bytes are unreadable, and any
 * origin may fetch them (a shared viewer on Qi.Space does).
 */
import type { OracleWorkerEnv } from '../do/contracts';
import { ARTIFACT_ID_RE, artifactObjectKey } from './store';
import { viewerContentSecurityPolicy, viewerHtml } from './viewer-page';

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
};

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: {
      'content-type': 'text/plain',
      'access-control-allow-origin': '*',
      ...SECURITY_HEADERS,
    },
  });
}

export async function artifactPageResponse(
  env: Pick<OracleWorkerEnv, 'ORACLE_NAME' | 'ARTIFACT_BUCKET'>,
  artifactId: string,
): Promise<Response> {
  if (!env.ARTIFACT_BUCKET || !ARTIFACT_ID_RE.test(artifactId))
    return notFound();
  return new Response(viewerHtml(env.ORACLE_NAME || 'QiForge oracle'), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': await viewerContentSecurityPolicy(),
      'cache-control': 'public, max-age=300',
      ...SECURITY_HEADERS,
    },
  });
}

export async function artifactDataResponse(
  env: Pick<OracleWorkerEnv, 'ARTIFACT_BUCKET'>,
  artifactId: string,
  now: number = Date.now(),
): Promise<Response> {
  const bucket = env.ARTIFACT_BUCKET;
  if (!bucket || !ARTIFACT_ID_RE.test(artifactId)) return notFound();
  const object = await bucket.get(artifactObjectKey(artifactId));
  if (!object) return notFound();
  const expiresAt = Date.parse(object.customMetadata?.expiresAt ?? '');
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    await bucket.delete(artifactObjectKey(artifactId));
    return new Response('Expired', {
      status: 410,
      headers: {
        'content-type': 'text/plain',
        'access-control-allow-origin': '*',
        ...SECURITY_HEADERS,
      },
    });
  }
  return new Response(object.body, {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'private, max-age=60',
      'access-control-allow-origin': '*',
      ...SECURITY_HEADERS,
    },
  });
}
