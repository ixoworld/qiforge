import { readBoundedBody } from '../shell/turn-body-cap';
import { z } from 'zod';
import {
  BYO_PROVIDERS,
  BYO_PROVIDER_MODELS,
  parseByoModelId,
  toByoModelId,
} from '../llm/byo-catalog';
import type { WorkersByoService, ByoTurnState } from '../llm/byo-service';
import {
  ReporterError,
  sessionBodySchema,
  turnBodySchema,
  validateSnapshot,
  type Snapshot,
  type ReporterRun,
  type HistoryTurn,
} from './contracts';
import {
  reportingSkill,
  executeReportingSkill,
  ReportingOutputError,
} from './skill';
import type { ReporterStore } from './store';

export interface ReporterProfileOptions {
  profile: 'reporter-grounded-v1';
}
export class ReporterService {
  constructor(
    private readonly deps: {
      store: ReporterStore;
      byo: WorkersByoService;
      userDid: string;
      persist: () => Promise<void>;
      background: (work: Promise<void>) => void;
      controllers: Map<string, AbortController>;
      execute?: (
        snapshot: Snapshot,
        message: string,
        turn: ByoTurnState,
        history: HistoryTurn[],
        signal?: AbortSignal,
      ) => ReturnType<typeof executeReportingSkill>;
    },
  ) {}
  async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/reporter/capabilities' && request.method === 'GET') {
        const creds = await this.deps.byo.getCredentials(this.deps.userDid, {
          refresh: true,
        });
        return Response.json({
          version: 1,
          profile: 'reporter-grounded-v1',
          models: BYO_PROVIDERS.flatMap((provider) =>
            BYO_PROVIDER_MODELS[provider].map((model) => ({
              id: toByoModelId(provider, model.id),
              label: model.label,
              funding: 'byo_only',
              available: Boolean(creds[provider]),
              ...(!creds[provider]
                ? { reason: 'Connect your provider credential in Companion' }
                : {}),
            })),
          ),
          privateOwnerState: true,
          skill: await reportingSkill(),
          platformCredits: false,
        });
      }
      if (path === '/reporter/sessions' && request.method === 'POST') {
        const body = sessionBodySchema.parse(await this.body(request));
        await validateSnapshot(body.snapshot);
        const session = await this.deps.store.createSession(
          body.requestId,
          body.snapshot,
        );
        await this.deps.persist();
        return Response.json(session);
      }
      const recovery = /^\/reporter\/session-requests\/([^/]+)$/.exec(path);
      if (recovery && request.method === 'GET') {
        const session = await this.deps.store.sessionRequest(
          z.uuid().parse(recovery[1]),
        );
        await this.deps.persist();
        return Response.json(session);
      }
      const cancel =
        /^\/reporter\/sessions\/([^/]+)\/turns\/([^/]+)\/cancel$/.exec(path);
      if (cancel && request.method === 'POST') {
        const run = await this.deps.store.getRun(
          z.uuid().parse(cancel[1]),
          z.uuid().parse(cancel[2]),
        );
        if (!run) throw new ReporterError(404, 'Reporter request not found');
        if (run.status === 'pending' || run.status === 'running') {
          run.status = 'uncertain';
          run.error =
            'Cancellation requested; provider usage may still have occurred';
          if (!(await this.deps.store.transition(run, ['pending', 'running'])))
            return Response.json(
              await this.deps.store.getRun(run.sessionId, run.requestId),
            );
          this.deps.controllers.get(run.runId)?.abort();
          await this.deps.persist();
        }
        return Response.json(run);
      }
      const match =
        /^\/reporter\/sessions\/([^/]+)(?:\/turns(?:\/([^/]+))?)?$/.exec(path);
      if (!match) return new Response('Not found', { status: 404 });
      const sessionId = z.uuid().parse(match[1]);
      if (path.endsWith('/turns') && request.method === 'POST') {
        const body = turnBodySchema.parse(await this.body(request));
        const { run, created } = await this.deps.store.reserve(sessionId, body);
        if (created) {
          try {
            await this.deps.persist();
          } catch {
            run.status = 'failed';
            run.error = 'Owner persistence failed before execution';
            await this.deps.store.transition(run, ['pending']);
            throw new ReporterError(503, run.error);
          }
          this.deps.background(this.execute(run, body));
        }
        return Response.json(run, {
          status:
            run.status === 'pending' || run.status === 'running' ? 202 : 200,
        });
      }
      if (request.method === 'GET' && match[2]) {
        const run = await this.deps.store.getRun(
          sessionId,
          z.uuid().parse(match[2]),
        );
        if (!run) throw new ReporterError(404, 'Reporter request not found');
        await this.deps.persist();
        return Response.json(run, {
          status:
            run.status === 'pending' || run.status === 'running' ? 202 : 200,
        });
      }
      if (request.method === 'GET' && !path.endsWith('/turns')) {
        const cursor = url.searchParams.get('cursor');
        if (
          [...url.searchParams.keys()].some((key) => key !== 'cursor') ||
          url.searchParams.getAll('cursor').length > 1
        )
          throw new ReporterError(400, 'Invalid session cursor');
        const session = await this.deps.store.session(
          sessionId,
          cursor === null ? undefined : z.uuid().parse(cursor),
        );
        await this.deps.persist();
        return Response.json(session);
      }
      return new Response('Not found', { status: 404 });
    } catch (error) {
      const status =
        error instanceof ReporterError
          ? error.status
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : 503;
      return Response.json(
        {
          error:
            error instanceof ReporterError
              ? error.message
              : status === 400
                ? 'Invalid Reporter request'
                : 'Reporter owner state unavailable',
        },
        { status },
      );
    }
  }
  private async body(request: Request): Promise<unknown> {
    const raw = await readBoundedBody(request);
    if (raw === null)
      throw new ReporterError(413, 'Reporter request too large');
    return JSON.parse(raw);
  }
  private async execute(
    run: ReporterRun,
    body: z.infer<typeof turnBodySchema>,
  ): Promise<void> {
    let inferred = false;
    const controller = new AbortController();
    this.deps.controllers.set(run.runId, controller);
    try {
      if (body.funding !== 'byo_only')
        throw new ReporterError(403, 'Platform credits are not available');
      if (!parseByoModelId(body.model))
        throw new ReporterError(400, 'Model is not configured');
      await this.deps.byo.getCredentials(this.deps.userDid, { refresh: true });
      const turn = await this.deps.byo.resolveForTurn({
        userDid: this.deps.userDid,
        requestedModel: body.model,
      });
      if (!turn || turn.byoModelId !== body.model)
        throw new ReporterError(
          403,
          'The selected model requires a connected provider credential',
        );
      const snapshot = await this.deps.store.snapshot(run.sessionId);
      controller.signal.throwIfAborted();
      run.status = 'running';
      if (!(await this.deps.store.transition(run, ['pending'])))
        throw new ReporterError(409, 'Reporter request is already terminal');
      await this.deps.persist();
      controller.signal.throwIfAborted();
      inferred = true;
      const result = await (this.deps.execute ?? executeReportingSkill)(
        snapshot,
        body.message,
        turn,
        run.history,
        controller.signal,
      );
      run.skill = result.skill;
      run.execution = result.execution;
      controller.signal.throwIfAborted();
      Object.assign(run, result, { status: 'completed' });
    } catch (error) {
      if (error instanceof ReportingOutputError) {
        run.skill = error.skill;
        run.execution = error.execution;
      }
      run.status =
        inferred && !(error instanceof ReportingOutputError)
          ? 'uncertain'
          : 'failed';
      run.error =
        error instanceof ReportingOutputError
          ? 'Provider output failed Reporter validation'
          : error instanceof ReporterError
            ? error.message
            : inferred
              ? 'Provider result could not be confirmed; this request will not be inferred again'
              : 'Reporter execution could not start';
    }
    this.deps.controllers.delete(run.runId);
    if (!(await this.deps.store.transition(run, ['pending', 'running']))) {
      const current = await this.deps.store.getRun(
        run.sessionId,
        run.requestId,
      );
      if (current?.status !== 'uncertain' || !run.execution || !run.skill)
        return;
      await this.deps.store.transition(
        { ...current, execution: run.execution, skill: run.skill },
        ['uncertain'],
      );
    }
    await this.deps.persist();
  }
}
