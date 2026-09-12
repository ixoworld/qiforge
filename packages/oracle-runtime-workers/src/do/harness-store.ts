import { operationKey } from '../core/harness-store';
import type { HarnessStore } from '../core/harness-store';
import type { DoSqliteDatabase } from '../sqlite/database';

export class SqliteHarnessStore implements HarnessStore {
  private ready: Promise<void> | undefined;
  constructor(private readonly db: DoSqliteDatabase) {}
  private setup(): Promise<void> {
    return (this.ready ??= this.initialize().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    }));
  }
  private async initialize(): Promise<void> {
    await this.db.run(
      'CREATE TABLE IF NOT EXISTS harness_operations (operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, started_at TEXT NOT NULL)',
    );
    await this.db.run(
      'CREATE UNIQUE INDEX IF NOT EXISTS harness_pending_operation ON harness_operations(fingerprint)',
    );
    await this.db.run(
      'CREATE TABLE IF NOT EXISTS harness_usage (request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, usage TEXT NOT NULL)',
    );
    await this.db.run(
      'CREATE TABLE IF NOT EXISTS harness_results (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)',
    );
  }
  async recordUsage(
    requestId: string,
    sessionId: string,
    usage: unknown,
  ): Promise<void> {
    await this.setup();
    await this.db.run('INSERT OR REPLACE INTO harness_usage VALUES (?, ?, ?)', [
      requestId,
      sessionId,
      JSON.stringify(usage),
    ]);
  }
  async deleteSessionResults(sessionId: string): Promise<void> {
    await this.setup();
    await this.db.run('DELETE FROM harness_results WHERE session_id = ?', [
      sessionId,
    ]);
    await this.db.run('DELETE FROM harness_usage WHERE session_id = ?', [
      sessionId,
    ]);
  }
  async startOperation(
    sessionId: string,
    key: string,
    operationId: string,
  ): Promise<boolean> {
    await this.setup();
    const result = await this.db.run(
      'INSERT OR IGNORE INTO harness_operations VALUES (?, ?, ?, ?)',
      [operationId, sessionId, key, new Date().toISOString()],
    );
    return result.changes === 1;
  }
  /** Clear only after a returned outcome or an operator reconciles the external receipt. */
  async completeOperation(operationId: string): Promise<void> {
    await this.setup();
    await this.db.run('DELETE FROM harness_operations WHERE operation_id = ?', [
      operationId,
    ]);
  }
  async putResult(sessionId: string, content: string): Promise<string> {
    await this.setup();
    const id = await operationKey(sessionId, content);
    await this.db.run(
      'INSERT OR IGNORE INTO harness_results VALUES (?, ?, ?, ?)',
      [id, sessionId, content, new Date().toISOString()],
    );
    return id;
  }
  async readResult(
    sessionId: string,
    id: string,
    offset: number,
  ): Promise<string | null> {
    await this.setup();
    const row = await this.db.get<{ content: string }>(
      'SELECT substr(content, ?, 4000) AS content FROM harness_results WHERE id = ? AND session_id = ?',
      [offset + 1, id, sessionId],
    );
    return row?.content ?? null;
  }
}
