import type { Logger } from '../types.js';

/**
 * Kinds of records the audit trail carries. The audit trail is the operator's
 * evidence surface — it records authority-relevant decisions (what ran, what
 * was allowed or denied, what was retried, which model actually answered),
 * not UI streaming events.
 */
export type AuditRecordKind =
  | 'turn.start'
  | 'turn.end'
  | 'tool.allow'
  | 'tool.deny'
  | 'subagent.refusal-retry'
  | 'model.receipt'
  | 'route.decision';

/**
 * One append-only audit record. Free-text user content never appears here —
 * carry digests (`sha256Hex`) and identifiers instead, so the trail can be
 * retained and shared without leaking prompt contents.
 */
export interface AuditRecord {
  kind: AuditRecordKind;
  /** ISO-8601 timestamp, assigned by the writer. */
  at: string;
  sessionId?: string;
  requestId?: string;
  /** Digest of the acting user's DID — correlates records without raw DIDs. */
  userDidDigest?: string;
  /** Digest of the oracle config document in force, once config-as-data lands. */
  configDigest?: string;
  /** Digest of the data/model policy in force, once policy-as-data lands. */
  policyDigest?: string;
  /** Kind-specific fields. Digests and identifiers only — no free text. */
  detail: Record<string, unknown>;
}

/**
 * Append-only audit sink. Implementations must never throw into the caller's
 * request path — a failing audit backend degrades to logged errors, it does
 * not break turns.
 */
export interface AuditSink {
  append(record: AuditRecord): void | Promise<void>;
}

/**
 * SHA-256 digest as lowercase hex via WebCrypto. Works on Node 20+ and
 * workerd without any Node-specific import.
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Default sink: one structured line per record through the runtime logger,
 * prefixed `[audit]` so operators can filter or ship the stream separately
 * from diagnostics.
 */
export function createLoggerAuditSink(logger: Logger): AuditSink {
  return {
    append(record) {
      logger.log(`[audit] ${JSON.stringify(record)}`);
    },
  };
}

/** Fan out one record to several sinks; a failing sink never blocks the rest. */
export function composeAuditSinks(
  sinks: AuditSink[],
  logger?: Logger,
): AuditSink {
  return {
    append(record) {
      for (const sink of sinks) {
        try {
          const result = sink.append(record);
          if (result instanceof Promise) {
            result.catch((err: unknown) => {
              logger?.warn(
                `[audit] sink append failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          }
        } catch (err) {
          logger?.warn(
            `[audit] sink append failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },
  };
}
