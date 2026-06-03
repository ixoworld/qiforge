import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { Injectable, Logger } from '@nestjs/common';
import { type BaseMessage } from 'langchain';
import type {
  CompiledMainAgent,
  MainAgentRequestContext,
} from '../../graph/main-agent-types.js';
import { createMainAgent } from '../../graph/main-agent.js';
import type { TMainAgentGraphState } from '../../graph/state.js';
import { didToMatrixUserId } from '../../matrix/user-id.js';
import type { UcanDelegation } from '../../plugin-api/types.js';
import { UserPreferencesService } from '../../plugins/user-preferences/service/user-preferences.service.js';
import type { SendMessageRequest } from './messages.service.js';
import { OracleRuntimeBundleHolder } from './oracle-runtime-bundle.js';
import { type PreparedRequest } from './request-preparer.js';
import { UserContextFetcher } from './user-context-fetcher.js';

export interface BuildAgentArgs {
  payload: SendMessageRequest;
  prepared: PreparedRequest;
  inputMessages: BaseMessage[];
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
 * `UserContextFetcher` caches per room for 3 minutes; `UserPreferencesService`
 * caches internally too. Both fall through to `priorState` if the fetch
 * fails or the upstream is unconfigured.
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

  constructor(
    private readonly bundleHolder: OracleRuntimeBundleHolder,
    private readonly userContextFetcher: UserContextFetcher,
  ) {}

  async build(
    args: BuildAgentArgs,
    abortController?: AbortController,
  ): Promise<BuiltAgent> {
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
    let checkpointer: BaseCheckpointSaver | undefined;
    if (hooks.checkpointerForUser) {
      checkpointer = await hooks.checkpointerForUser(payload.did);
    }

    let priorState: Partial<TMainAgentGraphState> = {};
    if (checkpointer) {
      try {
        const tuple = await checkpointer.getTuple({
          configurable: { thread_id: prepared.langchainThreadId },
        });
        const channelValues = tuple?.checkpoint?.channel_values as
          | Partial<TMainAgentGraphState>
          | undefined;
        if (channelValues) priorState = channelValues;
      } catch {
        // First message in a thread — no prior tuple. Continue with empty state.
      }
    }

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

    const userPrefsService = UserPreferencesService.getInstance();
    const [freshUserContext, freshUserPreferences] = await Promise.all([
      this.userContextFetcher
        .fetch({
          roomId: prepared.roomId,
          userDid: payload.did,
          sessionId: prepared.sessionId,
        })
        .catch((err) => {
          this.logger.warn(
            `[AgentBuilder] userContext fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return undefined;
        }),
      userPrefsService.get(prepared.roomId).catch((err) => {
        this.logger.warn(
          `[AgentBuilder] userPreferences fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }),
    ]);

    const userContext = freshUserContext ?? priorState.userContext;
    const userPreferences = freshUserPreferences ?? priorState.userPreferences;

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

    const clientType: 'portal' | 'matrix' | 'slack' =
      payload.clientType ?? 'portal';

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
          // Matrix listener path has no per-user UCAN — the bot acts as
          // the oracle, not as a user. Plugins that need a delegation
          // should branch on `raw.length === 0` and skip the mint.
          raw: '',
        };

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
    };

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
    };

    const agent = await createMainAgent({
      registries: bundle.registries,
      identity: bundle.identity,
      config: bundle.config,
      availablePlugins: bundle.availablePlugins,
      hooks,
      ambient: bundle.ambient,
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
    };

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
      recursionLimit: 150,
      configurable: prepared.runnableConfig.configurable,
      context: requestCtx,
      ...(abortController && { signal: abortController.signal }),
    };

    return { agent, stateInput, langGraphConfig };
  }
}
