import type { OracleWorkerEnv } from '../do/contracts';

/**
 * Links default to "anyone with the link", expiring after this many days.
 * The decision and its review note live in the repository README.
 */
export const DEFAULT_ARTIFACT_TTL_DAYS = 30;
/** Expiry is part of the policy: no setting makes a link permanent. */
export const MAX_ARTIFACT_TTL_DAYS = 365;

/** How often the cron starts a full sweep of expired share copies. */
export const DEFAULT_ARTIFACT_SWEEP_INTERVAL_HOURS = 24;
export const MAX_ARTIFACT_SWEEP_INTERVAL_HOURS = 168;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Where share links point: the oracle's `/a/:id`, or a shared viewer page. */
export interface ArtifactLinkBase {
  /** The oracle Worker's public origin; share copies are served under `/a/`. */
  publicUrl: string;
  /** A shared viewer page (Qi.Space). Unset → the oracle's own `/a/:id` page. */
  viewerUrl?: string;
}

/**
 * Artefact storage. `links` is null while no usable public origin is set:
 * no new artefact is created then, but the ones already stored stay
 * readable, revocable and deleted with their session, because the bucket
 * still holds their share copies.
 */
export interface ArtifactStorageConfig {
  bucket: R2Bucket;
  ttlMs: number;
  links: ArtifactLinkBase | null;
}

type ArtifactEnv = Pick<
  OracleWorkerEnv,
  | 'ARTIFACT_BUCKET'
  | 'ORACLE_PUBLIC_URL'
  | 'ARTIFACT_VIEWER_URL'
  | 'ARTIFACT_LINK_TTL_DAYS'
>;

function isLocalHost(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

/** https, or http on localhost: a link carries its decryption key. */
export function isSecureUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && isLocalHost(url))
    );
  } catch {
    return false;
  }
}

/**
 * Null when no bucket is bound. The env schema (`src/core/env.ts`) rejects a
 * malformed or insecure URL and an out-of-range TTL at boot; anything that
 * still reaches here unusable is reported through `warn`, never dropped
 * silently.
 */
export function artifactStorageConfig(
  env: ArtifactEnv,
  warn: (message: string) => void = () => undefined,
): ArtifactStorageConfig | null {
  const bucket = env.ARTIFACT_BUCKET;
  if (!bucket) {
    if (env.ORACLE_PUBLIC_URL)
      warn(
        '[artifacts] ORACLE_PUBLIC_URL is set but no ARTIFACT_BUCKET is bound: artefacts are off',
      );
    return null;
  }
  let links: ArtifactLinkBase | null = null;
  if (!env.ORACLE_PUBLIC_URL)
    warn(
      '[artifacts] ARTIFACT_BUCKET is bound but ORACLE_PUBLIC_URL is not set: no new artefacts; stored ones stay readable and revocable',
    );
  else if (!isSecureUrl(env.ORACLE_PUBLIC_URL))
    warn(
      `[artifacts] ORACLE_PUBLIC_URL must be an https URL (http only on localhost), got ${JSON.stringify(env.ORACLE_PUBLIC_URL)}: no new artefacts; stored ones stay readable and revocable`,
    );
  else {
    const viewerRaw = env.ARTIFACT_VIEWER_URL;
    const viewer =
      viewerRaw && isSecureUrl(viewerRaw) ? new URL(viewerRaw) : null;
    if (viewerRaw && !viewer)
      warn(
        `[artifacts] ARTIFACT_VIEWER_URL must be an https URL (http only on localhost), got ${JSON.stringify(viewerRaw)}: links use the oracle's own viewer`,
      );
    links = {
      publicUrl: new URL(env.ORACLE_PUBLIC_URL).origin,
      ...(viewer ? { viewerUrl: `${viewer.origin}${viewer.pathname}` } : {}),
    };
  }
  let days = DEFAULT_ARTIFACT_TTL_DAYS;
  if (env.ARTIFACT_LINK_TTL_DAYS !== undefined) {
    const parsed = Number(env.ARTIFACT_LINK_TTL_DAYS);
    if (
      Number.isInteger(parsed) &&
      parsed >= 1 &&
      parsed <= MAX_ARTIFACT_TTL_DAYS
    )
      days = parsed;
    else
      warn(
        `[artifacts] ARTIFACT_LINK_TTL_DAYS must be a whole number from 1 to ${MAX_ARTIFACT_TTL_DAYS}, got ${JSON.stringify(env.ARTIFACT_LINK_TTL_DAYS)}: links last ${DEFAULT_ARTIFACT_TTL_DAYS} days`,
      );
  }
  return { bucket, ttlMs: days * DAY_MS, links };
}

/**
 * The interval between full sweeps. The env schema rejects an out-of-range
 * value at boot; one that still reaches the cron is reported through `warn`
 * and replaced by the default.
 */
export function artifactSweepIntervalMs(
  env: Pick<OracleWorkerEnv, 'ARTIFACT_SWEEP_INTERVAL_HOURS'>,
  warn: (message: string) => void = () => undefined,
): number {
  const raw = env.ARTIFACT_SWEEP_INTERVAL_HOURS;
  if (raw === undefined) return DEFAULT_ARTIFACT_SWEEP_INTERVAL_HOURS * HOUR_MS;
  const hours = Number(raw);
  if (
    Number.isInteger(hours) &&
    hours >= 1 &&
    hours <= MAX_ARTIFACT_SWEEP_INTERVAL_HOURS
  )
    return hours * HOUR_MS;
  warn(
    `[artifacts] ARTIFACT_SWEEP_INTERVAL_HOURS must be a whole number from 1 to ${MAX_ARTIFACT_SWEEP_INTERVAL_HOURS}, got ${JSON.stringify(raw)}: sweeping every ${DEFAULT_ARTIFACT_SWEEP_INTERVAL_HOURS} hours`,
  );
  return DEFAULT_ARTIFACT_SWEEP_INTERVAL_HOURS * HOUR_MS;
}

/**
 * Where a person opens an artefact. The oracle's own page reads the key from
 * its fragment; a shared viewer also gets the source in the fragment, so its
 * server learns nothing either.
 */
export function artifactLink(
  config: ArtifactLinkBase,
  artifactId: string,
  key: string,
): string {
  const source = `${config.publicUrl}/a/${artifactId}`;
  return config.viewerUrl
    ? `${config.viewerUrl}#a=${encodeURIComponent(source)}&k=${key}`
    : `${source}#k=${key}`;
}
