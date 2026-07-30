import { MatrixManager } from '@ixo/matrix';
import { ReasoningEvent } from '@ixo/oracles-events';
import { type Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type BaseMessage } from 'langchain';
import type {
  CompiledMainAgent,
  MainAgentRequestContext,
} from '../../graph/main-agent-types.js';
import { createMainAgent } from '../../graph/main-agent.js';
import type { TMainAgentGraphState } from '../../graph/state.js';
import { createByoLlmAdapter } from '../../llm/byo-adapter.js';
import { isByoModelId, type ByoProvider } from '../../llm/byo-catalog.js';
import { isAllowedModel } from '../../llm/model-catalog.js';
import { buildByoFallbackNotice } from '../../llm/provider-error.js';
import { didToMatrixUserId } from '../../matrix/user-id.js';
import type { UcanDelegation } from '../../plugin-api/types.js';
import {
  ByoLlmService,
  type ByoTurnState,
} from '../byo-llm/byo-llm.service.js';
import { UcanService } from '../ucan/ucan.service.js';
import { EditorPlugin } from '../../plugins/editor/editor.plugin.js';
import { UserPreferencesService } from '../../plugins/user-preferences/service/user-preferences.service.js';
import { resolveLangsmithTracing } from './langsmith-tracing.js';
import type { SendMessageRequest } from './messages.service.js';
import { OracleRuntimeBundleHolder } from './oracle-runtime-bundle.js';
import { type PreparedRequest } from './request-preparer.js';
import { emitSSEEvent, emitSSERawEvent } from './sse.utils.js';
import { UserContextFetcher } from './user-context-fetcher.js';

export interface BuildAgentArgs {
  payload: SendMessageRequest;
  prepared: PreparedRequest;
  inputMessages: BaseMessage[];
}

/**
 * A checkpointer that also exposes the history-skipping read added to
 * `SqliteSaver`. The method is optional so any `BaseCheckpointSaver` (incl.
 * fork-supplied ones without it) is assignable; `supportsLightRead` narrows.
 */
type CheckpointerWithLightRead = BaseCheckpointSaver & {
  getTupleWithoutMessages?: BaseCheckpointSaver['getTuple'];
};

function supportsLightRead(
  checkpointer: CheckpointerWithLightRead,
): checkpointer is CheckpointerWithLightRead & {
  getTupleWithoutMessages: BaseCheckpointSaver['getTuple'];
} {
  return typeof checkpointer.getTupleWithoutMessages === 'function';
}

export interface BuiltAgent {
  agent: CompiledMainAgent;
  stateInput: Partial<TMainAgentGraphState>;
  /**
   * Config passed as the 2nd argument to `agent.streamEvents` /
   * `agent.invoke`. `version: 'v2'` is REQUIRED for streaming — without it
   * langchain defaults to v1 (or emits nothing) and the SSE connection
   * hangs with no events on the wire. `streamMode` + `recursionLimit`
   * match the apps/app reference values.
   *
   * Typed loosely (`Record<string, unknown>`) because langchain's
   * `streamEvents` config union doesn't perfectly intersect with the
   * langgraph-specific options we pass.
   */
  langGraphConfig: Record<string, unknown>;
  /**
   * The BYO provider the turn runs on, or `null` for platform turns. Lets
   * the SSE runner attribute a model-call failure to the user's own account
   * when classifying the error it sends to the client.
   */
  byoProvider: ByoProvider | null;
}

/**
 * Bridges a prepared HTTP request into a compiled `ReactAgent` ready to
 * stream or invoke.
 *
 * The checkpointer is supplied by the bundle's hooks — populated by
 * `createOracleApp` and NOT overridden here. Forks that pass a custom
 * `hooks.checkpointerForUser` to `createOracleApp` keep their override;
 * the runtime's per-user SQLite saver is the default fallback.
 *
 * `userContext` (Memory Engine batch) and `userPreferences` (Matrix room
 * state) are fetched HERE — before `createMainAgent` — and merged into the
 * build-time state so the system prompt includes them on turn 1.
 * `UserContextFetcher` caches per room for 5 minutes; `UserPreferencesService`
 * caches internally too. Both fall through to `priorState` if the fetch
 * fails or the upstream is unconfigured. The userContext fetch only BLOCKS
 * the build on true first contact (no checkpointed value) — on every later
 * turn the checkpointed value is served and the fetch refreshes the cache
 * in the background (stale-while-revalidate).
 *
 * Reads the prior checkpoint for OTHER build-time decisions: which
 * on-demand plugins are loaded (`state.loadedPlugins`) and the remembered
 * `currentEntityDid`. Without this preload, the first turn after restart
 * would expose no on-demand plugins.
 *
 * Per-request overrides from the payload (`metadata.editorRoomId`,
 * `metadata.spaceId`, `metadata.currentEntityDid`, `tools`, `agActions`)
 * win over the checkpointed values — both in the build-time state used by
 * `createMainAgent` and in the `stateInput` fed to `invoke` /
 * `streamEvents`. The annotation-state reducers persist the new values
 * on the next checkpoint.
 */
@Injectable()
export class AgentBuilder {
  private readonly logger = new Logger(AgentBuilder.name);

  /**
   * Default throttle window for the Matrix re-auth prompt: one prompt per
   * user per 6 hours. Overridable via `UCAN_REAUTH_PROMPT_THROTTLE_SECONDS`.
   */
  private static readonly DEFAULT_REAUTH_THROTTLE_SECONDS = 6 * 60 * 60;

  constructor(
    private readonly bundleHolder: OracleRuntimeBundleHolder,
    private readonly userContextFetcher: UserContextFetcher,
    private readonly ucan: UcanService,
    private readonly config: ConfigService,
    private readonly byoLlm: ByoLlmService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async build(
    args: BuildAgentArgs,
    abortController?: AbortController,
  ): Promise<BuiltAgent> {
    const buildStartedAt = performance.now();
    const { payload, prepared, inputMessages } = args;
    const bundle = this.bundleHolder.get();
    const hooks = bundle.hooks ?? {};

    // ────────────────────────────────────────────────────────────────────
    // Prior state from the checkpoint — used for build-time decisions that
    // must survive restarts: `loadedPlugins` (so on-demand capabilities
    // don't need to be re-loaded each session) and `currentEntityDid`.
    // We read via `checkpointer.getTuple(config)` — the same call
    // LangGraph itself makes inside `agent.getState()`. Between invokes
    // there are no pending writes so the tuple's `channel_values` matches
    // what `getState().values` would return; reading directly skips a
    // redundant agent rebuild + state-snapshot materialization.
    // ────────────────────────────────────────────────────────────────────
    const readPriorState = async (): Promise<{
      checkpointer: BaseCheckpointSaver | undefined;
      priorState: Partial<TMainAgentGraphState>;
    }> => {
      if (!hooks.checkpointerForUser) {
        return { checkpointer: undefined, priorState: {} };
      }
      const checkpointer = await hooks.checkpointerForUser(payload.did);
      try {
        // The build only reads scalar channel_values (loadedPlugins,
        // currentEntityDid, …), never the message history — so skip the
        // messages join here when the saver supports it. The agent's own
        // restore still loads full history.
        const cfg = {
          configurable: { thread_id: prepared.langchainThreadId },
        };
        const tuple = supportsLightRead(checkpointer)
          ? await checkpointer.getTupleWithoutMessages(cfg)
          : await checkpointer.getTuple(cfg);
        const channelValues = tuple?.checkpoint?.channel_values as
          | Partial<TMainAgentGraphState>
          | undefined;
        return { checkpointer, priorState: channelValues ?? {} };
      } catch {
        // First message in a thread — no prior tuple. Continue with empty state.
        return { checkpointer, priorState: {} };
      }
    };

    // ────────────────────────────────────────────────────────────────────
    // Fetch userContext + userPreferences BEFORE building the agent so the
    // system prompt sees both on turn 1. The previous middleware approach
    // wrote them mid-run, by which point the prompt was already locked.
    // Both are best-effort: failures fall through to checkpointed values
    // and the agent still works without enrichment.
    // ────────────────────────────────────────────────────────────────────
    this.logger.log(
      `[AgentBuilder] resolving prompt enrichments — roomId=${prepared.roomId}, did=${payload.did}`,
    );

    const clientType: 'portal' | 'matrix' | 'slack' =
      payload.clientType ?? 'portal';

    // On the Matrix ingress path the request carries no per-user UCAN
    // delegation header (the bot acts as the user's agent, not as the user).
    // Read the durably-stored delegation through so Matrix turns get UCAN
    // tooling. Folded into the same `Promise.all` so it adds no serial
    // round-trip; best-effort (falls back to no delegation on failure).
    const needsMatrixDelegation =
      clientType === 'matrix' && !payload.ucanDelegation;

    // The checkpoint read and the enrichment fetches touch disjoint stores
    // (local SQLite vs Memory Engine / Matrix room state), so they run in a
    // single Promise.all — the slowest leg gates the build, not the sum.
    //
    // The userContext fetch is started here but NOT awaited in the batch:
    // whether we wait for it depends on the checkpoint (stale-while-
    // revalidate below), and the checkpoint is one of the batch's own legs.
    const userContextPromise = this.userContextFetcher
      .fetch({
        roomId: prepared.roomId,
        userDid: payload.did,
        sessionId: prepared.sessionId,
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `[AgentBuilder] userContext fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      });

    // Per-request model override, resolved BEFORE the parallel batch because
    // the BYO leg needs it. Platform ids are gated by the catalog allow-list;
    // `byo:` ids are validated (and bound to a connected credential) inside
    // `ByoLlmService.resolveForTurn`. An unknown id is dropped and the turn
    // falls back to the default model.
    let requestedModel: string | undefined;
    let requestedByoModel: string | undefined;
    if (payload.model) {
      if (isByoModelId(payload.model)) {
        requestedByoModel = payload.model;
      } else if (isAllowedModel(payload.model)) {
        requestedModel = payload.model;
      } else {
        this.logger.warn(
          `Ignoring unknown model "${payload.model}" — falling back to the default model.`,
        );
      }
    }

    const userPrefsService = UserPreferencesService.getInstance();
    const [
      { checkpointer, priorState },
      freshUserPreferences,
      matrixDelegationRaw,
      byoTurn,
    ] = await Promise.all([
      readPriorState(),
      userPrefsService.get(prepared.roomId).catch((err) => {
        this.logger.warn(
          `[AgentBuilder] userPreferences fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }),
      needsMatrixDelegation
        ? this.ucan.getDelegationForUser(payload.did).catch((err) => {
            this.logger.warn(
              `[AgentBuilder] delegation read-through failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
          })
        : Promise.resolve(null),
      // BYO credential resolution. An explicit *platform* model choice keeps
      // the turn platform-paid, so the lookup is skipped entirely; a `byo:`
      // choice (or no choice at all — the Matrix/Slack ingress) resolves the
      // user's connected credential. No-ops to null when BYO_LLM_ENABLED is
      // off. Best-effort: a resolution failure degrades to a platform turn.
      requestedModel !== undefined
        ? Promise.resolve<ByoTurnState | null>(null)
        : this.byoLlm
            .resolveForTurn({
              userDid: payload.did,
              homeServerName: prepared.homeServerName,
              requestedModel: requestedByoModel,
            })
            .catch((err: unknown): ByoTurnState | null => {
              this.logger.warn(
                `[AgentBuilder] BYO credential resolution failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              // The user expected their own credential (they have one
              // connected, or explicitly picked a `byo:` model) — tell them
              // the turn degraded to the platform model instead of failing
              // silently. No-op outside an SSE request context.
              emitSSERawEvent('error', buildByoFallbackNotice('error'));
              return null;
            }),
    ]);

    // Stale-while-revalidate: when the checkpoint already carries a
    // userContext (every turn but the first), serve it immediately and let
    // the in-flight fetch warm the fetcher's cache for the NEXT turn instead
    // of gating this one — the Memory Engine round-trip was the single
    // largest pre-model cost on the chat hot path. Only a thread with no
    // prior context (true first contact) waits, and `UserContextFetcher`
    // caps that wait internally.
    let freshUserContext: Record<string, unknown> | undefined;
    if (priorState.userContext !== undefined) {
      void userContextPromise;
      freshUserContext = undefined;
    } else {
      // Surface an honest progress note IF the fetch is actually slow —
      // emitted only past a short grace so a warm cache never flashes it.
      // No-op outside an SSE request context (batch path, Matrix path).
      const noticeTimer = setTimeout(() => {
        emitSSEEvent(
          ReasoningEvent.createChunk(
            prepared.sessionId,
            prepared.requestId,
            'Recalling your memories...',
            [{ type: 'thinking', text: 'Recalling your memories...' }],
            false,
          ),
        );
      }, 300);
      freshUserContext = await userContextPromise;
      clearTimeout(noticeTimer);
    }

    const userContext = freshUserContext ?? priorState.userContext;
    const userPreferences = freshUserPreferences ?? priorState.userPreferences;

    // No valid stored delegation on a Matrix turn → emit a throttled
    // delegation-required event (the web app opens the authorize modal) and
    // proceed without UCAN tooling.
    if (needsMatrixDelegation && !matrixDelegationRaw) {
      await this.maybePromptReauth(payload.did, prepared.roomId);
    }

    this.logger.log(
      `[AgentBuilder] prompt enrichments resolved — userContext: ${
        freshUserContext
          ? `fresh (${Object.keys(freshUserContext).length} keys)`
          : priorState.userContext
            ? `checkpoint (${Object.keys(priorState.userContext).length} keys)`
            : 'none'
      }, userPreferences: ${
        freshUserPreferences
          ? 'fresh'
          : priorState.userPreferences
            ? 'checkpoint'
            : 'none'
      }`,
    );

    const ucanDelegation: UcanDelegation = payload.ucanDelegation
      ? {
          raw: payload.ucanDelegation.raw,
          issuer: payload.ucanDelegation.issuer,
          audience: payload.ucanDelegation.audience,
          // Translate UCAN spec naming (`can`/`with`) to the plugin-API
          // naming (`action`/`resource`). `nb` (caveats) is dropped here
          // — plugins that need caveats can read `raw` and re-parse.
          capabilities: payload.ucanDelegation.capabilities
            .map((c) => c as { can?: string; with?: string })
            .map((c) => ({
              action: c.can ?? '',
              resource: c.with ?? '',
            })),
        }
      : {
          // Matrix path has no per-request delegation header. We read the
          // durably-stored one through above; when present the plugins get
          // UCAN tooling, otherwise `raw: ''` and they branch on
          // `raw.length === 0` to skip the mint.
          raw: matrixDelegationRaw ?? '',
        };

    if (byoTurn) {
      this.logger.log(
        `[AgentBuilder] BYO turn — provider=${byoTurn.provider}, model=${byoTurn.mainModelId}, did=${payload.did}`,
      );
    }

    const requestCtx: MainAgentRequestContext = {
      user: {
        did: payload.did,
        matrixUserId: didToMatrixUserId(payload.did, prepared.homeServerName),
        ucanDelegation,
        timezone: prepared.timezone,
        currentTime: prepared.currentTime,
      },
      session: {
        id: prepared.sessionId,
        client: clientType,
        requestId: prepared.requestId,
        roomId: prepared.roomId,
      },
      history: { userContext },
      model: byoTurn ? byoTurn.byoModelId : requestedModel,
      ...(byoTurn && {
        byo: { provider: byoTurn.provider, active: true },
      }),
    };

    // The editor plugin is `on-demand` (so ordinary chats carry none of its
    // surface), but an open editor session must expose `call_editor_agent`
    // WITHOUT an explicit `load_capability` step — the capability gate reads
    // `loadedPlugins`, so seed it whenever the request (or the thread's
    // checkpoint) carries an active editor context. The state reducer is a
    // set-union, so re-seeding on later turns is a no-op.
    const editorSessionActive = Boolean(
      (payload.metadata?.editorRoomId ?? priorState.editorRoomId) ||
      (payload.metadata?.spaceId ?? priorState.spaceId),
    );
    const seededLoadedPlugins = editorSessionActive
      ? Array.from(
          new Set([...(priorState.loadedPlugins ?? []), EditorPlugin.NAME]),
        )
      : priorState.loadedPlugins;

    const buildTimeState: Partial<TMainAgentGraphState> = {
      ...priorState,
      userContext,
      userPreferences,
      editorRoomId: payload.metadata?.editorRoomId ?? priorState.editorRoomId,
      spaceId: payload.metadata?.spaceId ?? priorState.spaceId,
      currentEntityDid:
        payload.metadata?.currentEntityDid ?? priorState.currentEntityDid,
      browserTools: payload.tools ?? priorState.browserTools,
      agActions: payload.agActions ?? priorState.agActions,
      ...(seededLoadedPlugins !== undefined && {
        loadedPlugins: seededLoadedPlugins,
      }),
    };

    // The build resolves `checkpointerForUser` again for the compiled agent;
    // hand it the saver already resolved above instead of paying a second
    // per-user lookup in the same turn.
    const buildHooks = checkpointer
      ? { ...hooks, checkpointerForUser: () => Promise.resolve(checkpointer) }
      : hooks;

    // On a BYO turn, swap in a request-scoped LLM adapter so the main model,
    // sub-agents and plugin `rtCtx.llm` consumers all run on the user's
    // credential (roles the provider can't serve fall through to the platform
    // adapter inside the wrapper). A shallow spread per BYO turn; platform
    // turns reuse the boot-time ambient untouched.
    const ambient = byoTurn
      ? {
          ...bundle.ambient,
          llm: createByoLlmAdapter(bundle.ambient.llm, byoTurn),
        }
      : bundle.ambient;

    const agent = await createMainAgent({
      registries: bundle.registries,
      identity: bundle.identity,
      config: bundle.config,
      availablePlugins: bundle.availablePlugins,
      hooks: buildHooks,
      ambient,
      requestCtx,
      state: buildTimeState,
    });

    const stateInput: Partial<TMainAgentGraphState> = {
      messages: inputMessages,
      config: { did: payload.did },
      client: clientType,
      ...(userContext !== undefined && { userContext }),
      ...(userPreferences !== undefined && { userPreferences }),
      ...(payload.metadata?.editorRoomId !== undefined && {
        editorRoomId: payload.metadata.editorRoomId,
      }),
      ...(payload.metadata?.spaceId !== undefined && {
        spaceId: payload.metadata.spaceId,
      }),
      ...(payload.metadata?.currentEntityDid !== undefined && {
        currentEntityDid: payload.metadata.currentEntityDid,
      }),
      ...(payload.tools !== undefined && { browserTools: payload.tools }),
      ...(payload.agActions !== undefined && { agActions: payload.agActions }),
      ...(editorSessionActive && { loadedPlugins: [EditorPlugin.NAME] }),
    };

    // LangSmith: metadata (user DID, ingress client, pre-graph timings) is
    // attached unconditionally so any active tracer — the global env-driven
    // one or the selective per-DID one — can filter and aggregate per user;
    // it is inert when no tracer runs. `callbacks` appears only when this
    // user's DID is in the `LANGSMITH_TRACED_DIDS` allowlist, and the
    // explicit tracer propagates through the whole turn (model calls, tools,
    // sub-agents) via LangGraph's config inheritance.
    const tracing = resolveLangsmithTracing({
      userDid: payload.did,
      client: clientType,
      env: {
        tracing: this.config.get<string>('LANGSMITH_TRACING'),
        apiKey: this.config.get<string>('LANGSMITH_API_KEY'),
        project: this.config.get<string>('LANGSMITH_PROJECT'),
        tracedDids: this.config.get<string>('LANGSMITH_TRACED_DIDS'),
      },
      timings: {
        prepareDurationMs: prepared.prepareDurationMs,
        agentBuildDurationMs: Math.round(performance.now() - buildStartedAt),
      },
    });

    // `version: 'v2'` is REQUIRED for `agent.streamEvents` to emit the
    // `{event, data, tags}` envelope the SSE loop expects. Without it,
    // langchain defaults to v1 (or emits nothing) and the FE sees a
    // hanging connection with no events. `streamMode` + `recursionLimit`
    // mirror the apps/app reference. Typed `Record<string, unknown>`
    // because the langchain streamEvents config union doesn't perfectly
    // intersect with the langgraph-specific options here.
    const langGraphConfig: Record<string, unknown> = {
      version: 'v2',
      streamMode: ['updates', 'messages'],
      recursionLimit: 200,
      configurable: prepared.runnableConfig.configurable,
      context: requestCtx,
      metadata: tracing.metadata,
      ...(tracing.callbacks && { callbacks: tracing.callbacks }),
      ...(abortController && { signal: abortController.signal }),
    };

    return {
      agent,
      stateInput,
      langGraphConfig,
      byoProvider: byoTurn?.provider ?? null,
    };
  }

  /**
   * Emit a single throttled `ixo.oracle.delegation_required` event into the
   * user's Matrix room when a Matrix turn finds no valid delegation. The web
   * app listens for this event and opens the "authorize for Matrix" modal
   * in-place; the payload is self-contained (carries the oracle entity DID the
   * FE needs to mint + store a delegation), so the listener's location doesn't
   * matter. Throttled per user via the cache manager (key
   * `ucan_reauth_prompt_${userDid}`, TTL from
   * `UCAN_REAUTH_PROMPT_THROTTLE_SECONDS`, default 6h). Best-effort — never
   * throws, so a Matrix-send failure can't break the turn.
   */
  private async maybePromptReauth(
    userDid: string,
    roomId: string,
  ): Promise<void> {
    try {
      const throttleKey = `ucan_reauth_prompt_${userDid}`;
      const already = await this.cacheManager.get(throttleKey);
      if (already) {
        this.logger.debug(
          `[AgentBuilder] delegation-required event throttled for ${userDid} (already prompted within the window)`,
        );
        return;
      }

      const throttleSeconds =
        this.config.get<number>('UCAN_REAUTH_PROMPT_THROTTLE_SECONDS') ??
        AgentBuilder.DEFAULT_REAUTH_THROTTLE_SECONDS;

      await this.cacheManager.set(throttleKey, true, throttleSeconds * 1000);

      await MatrixManager.getInstance().sendMatrixEvent(
        roomId,
        'ixo.oracle.delegation_required',
        {
          oracleEntityDid: this.config.get<string>('ORACLE_ENTITY_DID'),
          oracleDid: this.config.get<string>('ORACLE_DID'),
        },
      );

      this.logger.log(
        `[AgentBuilder] sent ixo.oracle.delegation_required to room ${roomId} for ${userDid}`,
      );
    } catch (err) {
      this.logger.warn(
        `[AgentBuilder] delegation-required event failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
