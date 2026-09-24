import { DurableObject } from 'cloudflare:workers';
import { DoSqliteDatabase } from '../sqlite/database';
import { ReporterStore } from './store';
import { ReporterService } from './service';
import { WorkersByoService } from '../llm/byo-service';
import { BYO_SECRET_NAMES } from '../llm/byo-catalog';
import {
  canonical,
  sha256,
  type Narrative,
  type Snapshot,
  type TurnBody,
  type HistoryTurn,
} from './contracts';
import { ReportingOutputError, reportingSkill } from './skill';
import { SessionsStore } from '../sqlite/sessions-store';

export class ReporterTestDO extends DurableObject {
  private db?: DoSqliteDatabase;
  private instanceId = crypto.randomUUID();
  private background: Promise<void>[] = [];
  private controllers = new Map<string, AbortController>();
  private connected = true;
  private invalidOutput = false;
  private failOwner = false;
  private calls = 0;
  private hold = false;
  private release?: () => void;
  private async store(userDid = 'did:ixo:alice') {
    this.db ??= await DoSqliteDatabase.open(this.ctx, 'reporter-test.db');
    return new ReporterStore(
      this.db,
      {
        userDid,
        oracleDid: 'did:ixo:oracle',
        oracleEntityDid: 'did:ixo:entity',
        oracleName: 'Companion',
      },
      this.instanceId,
    );
  }
  async configure(options: {
    connected?: boolean;
    invalidOutput?: boolean;
    failOwner?: boolean;
    hold?: boolean;
  }) {
    this.invalidOutput = options.invalidOutput ?? this.invalidOutput;
    this.connected = options.connected ?? this.connected;
    this.failOwner = options.failOwner ?? this.failOwner;
    this.hold = options.hold ?? this.hold;
  }
  async request(path: string, body?: unknown, userDid = 'did:ixo:alice') {
    const store = await this.store(userDid);
    const byo = new WorkersByoService({
      enabled: true,
      resolveRoomId: async () => '!room',
      secrets: {
        getIndex: async () =>
          this.connected
            ? [{ name: BYO_SECRET_NAMES.openai, eventId: '$key' }]
            : [],
        getValues: async () => ({
          [BYO_SECRET_NAMES.openai]: 'secret-never-in-receipt',
        }),
        putSecret: async () => {},
        deleteSecret: async () => {},
      },
      store: {
        get: async () => undefined,
        put: async () => {},
        delete: async () => {},
      },
    });
    const service = new ReporterService({
      store,
      byo,
      userDid,
      controllers: this.controllers,
      persist: async () => {
        if (this.failOwner) throw new Error('owner unavailable');
      },
      background: (work) => {
        this.background.push(work);
      },
      execute: async (snapshot, message, turn, history, signal) => {
        this.calls++;
        if (this.hold)
          await new Promise<void>((resolve, reject) => {
            this.release = resolve;
            signal?.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
          });
        const fact = snapshot.facts[0];
        const narrative: Narrative = {
          version: 1,
          snapshotDigest: snapshot.digest,
          sections: [
            {
              topic: 'what',
              units: fact
                ? [{ kind: 'fact', ...fact }]
                : [
                    {
                      kind: 'missing',
                      text: 'This information is not recorded',
                    },
                  ],
            },
          ],
        };
        const result = {
          narrative,
          skill: {
            ...(await reportingSkill()),
            inputDigest: await sha256(
              canonical({ snapshot, message, history }),
            ),
            outputDigest: await sha256(canonical(narrative)),
          },
          execution: {
            requestedModel: turn.byoModelId,
            actualModel: turn.mainModelId,
            provider: turn.provider,
            funding: 'byo_only' as const,
            inputTokens: 12,
            outputTokens: 15,
            settlement: 'not_applicable' as const,
          },
        };
        if (this.invalidOutput)
          throw new ReportingOutputError(result.skill, result.execution);
        return result;
      },
    });
    const response = await service.handle(
      new Request(`https://companion${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: await response.text() };
  }
  async drain() {
    await Promise.all(this.background);
    this.background = [];
  }
  async callCount() {
    return this.calls;
  }
  async releaseExecution() {
    this.release?.();
  }
  async restart() {
    await this.db?.close();
    this.db = undefined;
    this.instanceId = crypto.randomUUID();
  }
  async reserve(snapshot: Snapshot, body: TurnBody) {
    const store = await this.store();
    const session = await store.createSession(crypto.randomUUID(), snapshot);
    const { run } = await store.reserve(session.sessionId, body);
    return run;
  }
  async seedRuns(
    sessionId: string,
    narrative: Narrative,
    history: HistoryTurn[],
    count: number,
  ) {
    const store = await this.store();
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const body: TurnBody = {
        version: 1,
        requestId: crypto.randomUUID(),
        message: `Synthetic question ${index}`,
        model: 'byo:openai/gpt-5.6-terra',
        funding: 'byo_only',
      };
      const { run } = await store.reserve(sessionId, body);
      await store.save({
        ...run,
        history,
        narrative,
        status: 'completed',
        skill: {
          ...(await reportingSkill()),
          inputDigest: await sha256(
            canonical({
              snapshot: await store.snapshot(sessionId),
              message: run.message,
              history,
            }),
          ),
          outputDigest: await sha256(canonical(narrative)),
        },
        execution: {
          requestedModel: body.model,
          actualModel: 'gpt-5.6-terra',
          provider: 'openai',
          funding: 'byo_only',
          inputTokens: 12,
          outputTokens: 15,
          settlement: 'not_applicable',
        },
      });
      ids.push(run.requestId);
    }
    return ids;
  }
  async genericSessions() {
    await this.store();
    if (!this.db) throw new Error('no db');
    const result = await new SessionsStore(this.db).listSessions(
      undefined,
      20,
      0,
      undefined,
      'reporter-grounded-v1',
    );
    return {
      sessions: result.sessions.map((s) => s.sessionId),
      total: result.total,
    };
  }
}
