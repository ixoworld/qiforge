import type { DoSqliteDatabase } from '../sqlite/database';
import { SessionsStore } from '../sqlite/sessions-store';
import {
  canonical,
  jsonBytes,
  REPORTER_VALUE_BYTES,
  REPORTER_PAGE_BYTES,
  sessionPageSchema,
  ReporterError,
  sha256,
  snapshotSchema,
  runSchema,
  validateSnapshot,
  type Snapshot,
  type ReporterRun,
  type TurnBody,
  type HistoryTurn,
  historyTurnSchema,
} from './contracts';

type SessionRow = {
  session_id: string;
  payload_digest: string;
  snapshot: string;
};
type RunRow = { payload_digest: string; result: string; instance_id: string };
export class ReporterStore {
  private setupPromise?: Promise<void>;
  constructor(
    private readonly db: DoSqliteDatabase,
    private readonly owner: {
      userDid: string;
      oracleDid: string;
      oracleEntityDid: string;
      oracleName: string;
    },
    private readonly instanceId: string,
  ) {}
  setup(): Promise<void> {
    this.setupPromise ??= (async () => {
      await new SessionsStore(this.db).setup();
      await this.db.run(
        'CREATE TABLE IF NOT EXISTS reporter_sessions (user_did TEXT NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, payload_digest TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(user_did, request_id))',
      );
      await this.db.run(
        'CREATE TABLE IF NOT EXISTS reporter_runs (user_did TEXT NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_digest TEXT NOT NULL, instance_id TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(user_did, session_id, request_id))',
      );
    })();
    return this.setupPromise;
  }
  async createSession(requestId: string, snapshot: Snapshot) {
    await this.setup();
    const payloadDigest = await sha256(canonical(snapshot));
    return this.db.transaction(async () => {
      const previous = await this.db.get<SessionRow>(
        'SELECT session_id, payload_digest, snapshot FROM reporter_sessions WHERE user_did=? AND request_id=?',
        [this.owner.userDid, requestId],
      );
      if (previous) {
        if (previous.payload_digest !== payloadDigest)
          throw new ReporterError(409, 'Request ID payload conflict');
        return {
          version: 1 as const,
          sessionId: previous.session_id,
          snapshotDigest: snapshot.digest,
        };
      }
      const sessionId = crypto.randomUUID();
      await this.db.run(
        'INSERT INTO reporter_sessions VALUES (?, ?, ?, ?, ?)',
        [
          this.owner.userDid,
          requestId,
          sessionId,
          payloadDigest,
          JSON.stringify(snapshot),
        ],
      );
      await new SessionsStore(this.db).createSession({
        sessionId,
        ...this.owner,
        title: snapshot.title,
        userContext: {
          profile: 'reporter-grounded-v1',
          snapshotDigest: snapshot.digest,
        },
      });
      return {
        version: 1 as const,
        sessionId,
        snapshotDigest: snapshot.digest,
      };
    });
  }
  async sessionRequest(requestId: string) {
    await this.setup();
    const row = await this.db.get<SessionRow>(
      'SELECT session_id, payload_digest, snapshot FROM reporter_sessions WHERE user_did=? AND request_id=?',
      [this.owner.userDid, requestId],
    );
    if (!row)
      throw new ReporterError(404, 'Reporter session request not found');
    return {
      version: 1 as const,
      sessionId: row.session_id,
      snapshotDigest: snapshotSchema.parse(JSON.parse(row.snapshot)).digest,
    };
  }
  async snapshot(sessionId: string): Promise<Snapshot> {
    await this.setup();
    const row = await this.db.get<SessionRow>(
      'SELECT session_id, payload_digest, snapshot FROM reporter_sessions WHERE user_did=? AND session_id=?',
      [this.owner.userDid, sessionId],
    );
    if (!row) throw new ReporterError(404, 'Reporter session not found');
    const snapshot = snapshotSchema.parse(JSON.parse(row.snapshot));
    await validateSnapshot(snapshot);
    return snapshot;
  }
  async getRun(
    sessionId: string,
    requestId: string,
  ): Promise<ReporterRun | undefined> {
    await this.snapshot(sessionId);
    const row = await this.db.get<RunRow>(
      'SELECT payload_digest, result, instance_id FROM reporter_runs WHERE user_did=? AND session_id=? AND request_id=?',
      [this.owner.userDid, sessionId, requestId],
    );
    if (!row) return undefined;
    const run = runSchema.parse(JSON.parse(row.result));
    if (
      row.instance_id !== this.instanceId &&
      (run.status === 'pending' || run.status === 'running')
    ) {
      run.status = 'uncertain';
      run.error =
        'Execution interrupted; this request will not be inferred again';
      await this.save(run);
    }
    return run;
  }
  async reserve(
    sessionId: string,
    body: TurnBody,
  ): Promise<{ run: ReporterRun; created: boolean }> {
    const snapshot = await this.snapshot(sessionId);
    const digest = await sha256(canonical(body));
    return this.db.transaction(async () => {
      const prior = await this.db.get<RunRow>(
        'SELECT payload_digest, result, instance_id FROM reporter_runs WHERE user_did=? AND session_id=? AND request_id=?',
        [this.owner.userDid, sessionId, body.requestId],
      );
      if (prior) {
        if (prior.payload_digest !== digest)
          throw new ReporterError(409, 'Request ID payload conflict');
        const run = await this.getRun(sessionId, body.requestId);
        if (!run) throw new Error('Reserved Reporter run missing');
        return { run, created: false };
      }
      const recent = await this.db.exec<{ result: string }>(
        "SELECT json_object('message', json_extract(result, '$.message'), 'narrative', json_extract(result, '$.narrative')) AS result FROM reporter_runs WHERE user_did=? AND session_id=? AND json_extract(result, '$.status')='completed' ORDER BY rowid DESC LIMIT 8",
        [this.owner.userDid, sessionId],
      );
      const history: HistoryTurn[] = [];
      for (const row of recent) {
        const next = historyTurnSchema.parse(JSON.parse(row.result));
        if (jsonBytes([...history, next]) > REPORTER_VALUE_BYTES) break;
        history.unshift(next);
        if (history.length === 8) break;
      }
      const run: ReporterRun = {
        version: 1,
        message: body.message,
        history,
        requestId: body.requestId,
        runId: crypto.randomUUID(),
        sessionId,
        snapshotDigest: snapshot.digest,
        status: 'pending',
      };
      await this.db.run('INSERT INTO reporter_runs VALUES (?, ?, ?, ?, ?, ?)', [
        this.owner.userDid,
        sessionId,
        body.requestId,
        digest,
        this.instanceId,
        JSON.stringify(run),
      ]);
      return { run, created: true };
    });
  }
  async save(run: ReporterRun): Promise<void> {
    runSchema.parse(run);
    await this.db.run(
      'UPDATE reporter_runs SET result=? WHERE user_did=? AND session_id=? AND request_id=?',
      [JSON.stringify(run), this.owner.userDid, run.sessionId, run.requestId],
    );
  }
  async transition(
    run: ReporterRun,
    from: ReporterRun['status'][],
  ): Promise<boolean> {
    runSchema.parse(run);
    const placeholders = from.map(() => '?').join(',');
    const result = await this.db.run(
      `UPDATE reporter_runs SET result=? WHERE user_did=? AND session_id=? AND request_id=? AND json_extract(result, '$.status') IN (${placeholders})`,
      [
        JSON.stringify(run),
        this.owner.userDid,
        run.sessionId,
        run.requestId,
        ...from,
      ],
    );
    return result.changes === 1;
  }
  async session(sessionId: string, cursor?: string) {
    const snapshot = await this.snapshot(sessionId);
    const boundary = cursor
      ? await this.db.get<{ rowid: number }>(
          'SELECT rowid FROM reporter_runs WHERE user_did=? AND session_id=? AND request_id=?',
          [this.owner.userDid, sessionId, cursor],
        )
      : undefined;
    if (cursor && !boundary)
      throw new ReporterError(400, 'Invalid session cursor');
    const rows = await this.db.exec<{ request_id: string }>(
      `SELECT request_id FROM reporter_runs WHERE user_did=? AND session_id=?${boundary ? ' AND rowid<?' : ''} ORDER BY rowid DESC LIMIT 51`,
      [this.owner.userDid, sessionId, ...(boundary ? [boundary.rowid] : [])],
    );
    const page = {
      version: 1 as const,
      sessionId,
      snapshot,
      runs: [] as ReporterRun[],
      nextCursor: null as string | null,
    };
    for (const row of rows) {
      const run = await this.getRun(sessionId, row.request_id);
      if (!run) throw new Error('Reporter page run missing');
      const candidate = {
        ...page,
        runs: [run, ...page.runs],
        nextCursor: run.requestId,
      };
      if (
        page.runs.length === 50 ||
        jsonBytes(candidate) > REPORTER_PAGE_BYTES
      ) {
        if (!page.runs.length)
          throw new ReporterError(503, 'Reporter run exceeds page limit');
        page.nextCursor = page.runs[0]!.requestId;
        break;
      }
      page.runs.unshift(run);
    }
    return sessionPageSchema.parse(page);
  }
}
