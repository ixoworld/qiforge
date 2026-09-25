import type { OracleWorkerEnv } from '../do/contracts';

/**
 * Links default to "anyone with the link", expiring after this many days.
 * The decision and its review note live in the repository README.
 */
export const DEFAULT_ARTIFACT_TTL_DAYS = 30;
/** Expiry is part of the policy: no setting makes a link permanent. */
export const MAX_ARTIFACT_TTL_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ArtifactLinkConfig {
  bucket: R2Bucket;
  /** The oracle Worker's public origin; share copies are served under `/a/`. */
  publicUrl: string;
  /** A shared viewer page (Qi.Space). Unset → the oracle's own `/a/:id` page. */
  viewerUrl?: string;
  ttlMs: number;
}

type ArtifactEnv = Pick<
  OracleWorkerEnv,
  | 'ARTIFACT_BUCKET'
  | 'ORACLE_PUBLIC_URL'
  | 'ARTIFACT_VIEWER_URL'
  | 'ARTIFACT_LINK_TTL_DAYS'
>;

function parsedUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
      return null;
    return url;
  } catch {
    return null;
  }
}

/** Null when artefacts are off: no bucket bound, or no public origin set. */
export function artifactLinkConfig(
  env: ArtifactEnv,
): ArtifactLinkConfig | null {
  const publicUrl = parsedUrl(env.ORACLE_PUBLIC_URL);
  if (!env.ARTIFACT_BUCKET || !publicUrl) return null;
  const viewer = parsedUrl(env.ARTIFACT_VIEWER_URL);
  const days = Number(env.ARTIFACT_LINK_TTL_DAYS);
  return {
    bucket: env.ARTIFACT_BUCKET,
    publicUrl: publicUrl.origin,
    ...(viewer ? { viewerUrl: `${viewer.origin}${viewer.pathname}` } : {}),
    ttlMs:
      (Number.isInteger(days) && days > 0
        ? Math.min(days, MAX_ARTIFACT_TTL_DAYS)
        : DEFAULT_ARTIFACT_TTL_DAYS) * DAY_MS,
  };
}

/**
 * Where a person opens an artefact. The oracle's own page reads the key from
 * its fragment; a shared viewer also gets the source in the fragment, so its
 * server learns nothing either.
 */
export function artifactLink(
  config: Pick<ArtifactLinkConfig, 'publicUrl' | 'viewerUrl'>,
  artifactId: string,
  key: string,
): string {
  const source = `${config.publicUrl}/a/${artifactId}`;
  return config.viewerUrl
    ? `${config.viewerUrl}#a=${encodeURIComponent(source)}&k=${key}`
    : `${source}#k=${key}`;
}
