/**
 * Per-turn domain-context provenance, kept in the user's own SQLite file
 * (`domain_context_runs`): which domain documents a turn was given, by CID,
 * with their status and findings. Bodies, credentials and reasoning are
 * never stored. A deleted session takes its rows with it
 * (`deleteForSession`). Diagnostics only: a failed write is logged with
 * `[domain-context]` and never fails the turn. The table is created by the
 * first recorded turn, so an oracle without domain context never has it.
 */
import type { DoSqliteDatabase } from '../sqlite/database';
import type { Logger } from '../plugin-api/types';
import type { DomainContextProvenance } from '../core/domain-context';

export interface DomainContextRunRow {
  requestId: string;
  sessionId: string;
  provenance: DomainContextProvenance[];
  createdAt: number;
}

export class DomainContextStore {
  private setupPromise: Promise<void> | undefined;

  constructor(
    private readonly db: Pick<DoSqliteDatabase, 'run' | 'exec'>,
    private readonly log: Pick<Logger, 'warn'>,
    private readonly now: () => number = Date.now,
  ) {}

  private setup(): Promise<void> {
    this.setupPromise ??= this.createTables().catch((error: unknown) => {
      this.setupPromise = undefined;
      throw error;
    });
    return this.setupPromise;
  }

  private async createTables(): Promise<void> {
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS domain_context_runs (
         request_id TEXT NOT NULL,
         session_id TEXT NOT NULL,
         provenance TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         PRIMARY KEY (session_id, request_id)
       )`,
    );
  }

  /** Record a turn's provenance; a resumed attempt of the same request replaces it. */
  async record(
    sessionId: string,
    requestId: string,
    provenance: DomainContextProvenance[],
  ): Promise<void> {
    try {
      await this.setup();
      await this.db.run(
        `INSERT OR REPLACE INTO domain_context_runs
           (request_id, session_id, provenance, created_at) VALUES (?, ?, ?, ?)`,
        [requestId, sessionId, JSON.stringify(provenance), this.now()],
      );
    } catch (error) {
      this.log.warn(
        `[domain-context] could not record the provenance of ${requestId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** A session's rows, oldest first (diagnostics and tests). */
  async listForSession(sessionId: string): Promise<DomainContextRunRow[]> {
    await this.setup();
    const rows = await this.db.exec<{
      request_id: string;
      session_id: string;
      provenance: string;
      created_at: number;
    }>(
      `SELECT request_id, session_id, provenance, created_at
       FROM domain_context_runs WHERE session_id = ?
       ORDER BY created_at, rowid`,
      [sessionId],
    );
    return rows.map((row) => ({
      requestId: row.request_id,
      sessionId: row.session_id,
      provenance: parseProvenance(row.provenance),
      createdAt: row.created_at,
    }));
  }

  /**
   * Delete a session's rows. Never creates the table: a database that has
   * never recorded a domain-context turn has nothing to delete.
   */
  async deleteForSession(sessionId: string): Promise<void> {
    if (!(await this.tableExists())) return;
    await this.db.run(`DELETE FROM domain_context_runs WHERE session_id = ?`, [
      sessionId,
    ]);
  }

  private async tableExists(): Promise<boolean> {
    const rows = await this.db.exec<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'domain_context_runs'`,
    );
    return rows.length > 0;
  }
}

function parseProvenance(json: string): DomainContextProvenance[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.filter(isProvenance) : [];
}

function isProvenance(value: unknown): value is DomainContextProvenance {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'did') === 'string' &&
    typeof Reflect.get(value, 'status') === 'string'
  );
}
