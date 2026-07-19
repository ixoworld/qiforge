import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditRecord, AuditSink } from '../kernel/audit.js';
import type { Logger } from '../plugin-api/types.js';

/**
 * JSONL file sink for the audit trail — one record per line, append-only.
 * Node-adapter-only (the portable kernel ships the types and the logger
 * sink; file persistence is a host concern). Failures are logged and
 * swallowed so a full disk or bad path can never break a turn.
 */
export function createFileAuditSink(path: string, logger: Logger): AuditSink {
  let dirReady: Promise<void> | null = null;
  const ensureDir = (): Promise<void> => {
    dirReady ??= mkdir(dirname(path), { recursive: true }).then(
      () => undefined,
    );
    return dirReady;
  };

  return {
    async append(record: AuditRecord) {
      try {
        await ensureDir();
        await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
      } catch (err) {
        logger.warn(
          `[audit] file sink write failed (${path}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
