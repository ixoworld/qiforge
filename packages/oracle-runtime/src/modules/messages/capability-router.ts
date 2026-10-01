import type { DecisionEvaluation } from '@ixo/common';
import {
  CAPABILITY_ROUTER_MODES,
  capabilityRouteDecision,
  decideCapabilityRoute,
  toRoutableCapabilities,
  type CapabilityRouteVerdict,
  type CapabilityRouterMode,
  type DecisionTraceOptions,
  type RoutableCapability,
} from '@ixo/common/ai/decisions';
import { Logger } from '@nestjs/common';
import {
  DecisionProviderUnavailableError,
  type DecisionEvaluator,
} from '../../decisions/decision-runtime.js';
import type { RegisteredManifest } from '../../registries/manifest-registry.js';

/** Log prefix of the live lane; one grep shows every routed turn. */
const LOG_PREFIX = '[capability-router]';
const SHADOW_LOG_PREFIX = '[capability-router-shadow]';

const NO_PRELOAD: ReadonlySet<string> = new Set<string>();

export interface CapabilityRouterDeps {
  /**
   * Resolved per turn, not at construction: the evaluator lives on the
   * boot-populated ambient runtime, which does not exist yet when Nest
   * constructs this service.
   */
  getDecisionEvaluator: () => DecisionEvaluator | undefined;
  logger?: Pick<Logger, 'log' | 'warn'>;
  /** Wall clock for the shadow latency field. */
  now?: () => number;
}

export interface CapabilityRouteRequest {
  /** Per-turn request id, so the shadow lines join the turn's other lines. */
  requestId: string;
  /** The validated `CAPABILITY_ROUTER` env value. Anything unrecognised is `off`. */
  mode: unknown;
  /** The user's message for this turn. Never logged. */
  text: string;
  /** Every registered manifest; the router picks the routable subset. */
  manifests: readonly RegisteredManifest[];
  /** Plugins already loaded for the thread — never candidates. */
  loadedPlugins: ReadonlySet<string>;
  /** Commerce lane of a routed Matrix turn; support mode skips the router. */
  commerceMode?: 'support' | 'work';
  /** Aborting the turn aborts a running evaluation, live or shadow. */
  signal?: AbortSignal;
  /**
   * The turn's tracer and trace metadata. The router runs before the graph,
   * outside any LangChain run, so without these its Decision is not traced.
   */
  trace?: DecisionTraceOptions;
}

/**
 * Shadow-mode handle for the one comparison the runtime can make cheaply:
 * after the turn, what did the model actually load versus what the router
 * would have preloaded?
 */
export interface CapabilityRouteShadow {
  /**
   * Log the agreement line once the shadow verdict settles. `agree` is
   * `true` when the prediction would have been useful and nothing more: an
   * empty prediction on a turn that loaded nothing, or a prediction whose
   * every plugin the model went on to load. Prints nothing when the shadow
   * evaluation failed — its own `status=failed` line already said so.
   */
  compare(finalLoadedPlugins: readonly string[] | undefined): void;
}

export interface CapabilityRouteOutcome {
  /**
   * Plugins to preload for THIS turn only. Empty unless the mode is `on` and
   * the verdict cleared the confidence floor. The caller hands this to
   * `createMainAgent` as `preloadedPlugins`; it must never be written into
   * graph state, whose `loadedPlugins` channel is a checkpointed set-union
   * that only `load_capability` may grow.
   */
  preloadedPlugins: ReadonlySet<string>;
  /** Present only in `shadow` mode, and only when an evaluation was started. */
  shadow?: CapabilityRouteShadow;
}

/**
 * Predicts, before the first model call of a turn, which on-demand plugin
 * the message needs, so its tools can be exposed without a `load_capability`
 * round trip. The prediction is the shared `runtime.route-capabilities`
 * Decision plus the deterministic `decideCapabilityRoute` policy; this class
 * owns the runtime concerns around it — mode, candidates, timing, fail-open
 * and logging.
 *
 * Three modes, from `CAPABILITY_ROUTER`:
 *
 *   - `off` (default): nothing is evaluated, nothing is logged.
 *   - `shadow`: evaluated and logged, never awaited by the turn and never
 *     preloading anything. The lines carry the raw probabilities so the
 *     confidence floor can be tuned from real traffic before switching on.
 *   - `on`: awaited (the Decision's own 2 s budget bounds the wait) and the
 *     verdict preloads. Anything that stops the Decision from answering — no
 *     evaluator, no provider, a timeout, an abort, a malformed answer — warns
 *     with safe metadata and preloads nothing; the turn proceeds as if the
 *     router were off.
 *
 * The router is skipped, in every mode, when there is nothing to route: no
 * on-demand plugin left unloaded, a blank message, or a Matrix support turn
 * (support mode binds an allowlist and no meta-tools, so a preload there
 * would contradict the mode).
 *
 * Log lines carry plugin names, probabilities and error type names only.
 * The message text never reaches a line, nor does a provider's message — a
 * third-party error can echo the Decision state, which includes the text.
 */
export class CapabilityRouter {
  private readonly getDecisionEvaluator: () => DecisionEvaluator | undefined;
  private readonly logger: Pick<Logger, 'log' | 'warn'>;
  private readonly now: () => number;
  /**
   * One-shot guard for the two boot-time reasons the router cannot run — no
   * evaluator on the ambient runtime, no Decision provider configured. Neither
   * changes without a restart, so each is said once per process; every other
   * failure warns on the turn it happens.
   */
  private unavailableNoticeLogged = false;

  constructor(deps: CapabilityRouterDeps) {
    this.getDecisionEvaluator = deps.getDecisionEvaluator;
    this.logger = deps.logger ?? new Logger(CapabilityRouter.name);
    this.now = deps.now ?? Date.now;
  }

  async route(
    request: CapabilityRouteRequest,
  ): Promise<CapabilityRouteOutcome> {
    const mode = parseMode(request.mode);
    if (mode === 'off') return { preloadedPlugins: NO_PRELOAD };
    if (request.commerceMode === 'support') {
      return { preloadedPlugins: NO_PRELOAD };
    }
    if (request.text.trim().length === 0) {
      return { preloadedPlugins: NO_PRELOAD };
    }

    const capabilities = routableCandidates(
      request.manifests,
      request.loadedPlugins,
    );
    if (capabilities.length === 0) return { preloadedPlugins: NO_PRELOAD };

    const evaluator = this.getDecisionEvaluator();
    if (!evaluator) {
      this.warnUnavailable(request, mode, 'missing-evaluator');
      return { preloadedPlugins: NO_PRELOAD };
    }

    // Prior turns are deliberately not part of the input. The builder reads
    // the checkpoint without its messages (that is what keeps the pre-model
    // path cheap), so the router sees the current message only; the
    // Decision's `recentTurns` stays empty rather than costing a history read.
    const input = { text: request.text, recentTurns: [], capabilities };
    const options = {
      ...request.trace,
      ...(request.signal && { signal: request.signal }),
    };
    const evaluate = () =>
      evaluator.evaluate(capabilityRouteDecision, input, options);

    if (mode === 'shadow') {
      return {
        preloadedPlugins: NO_PRELOAD,
        shadow: this.startShadow(request, capabilities, evaluate),
      };
    }

    return {
      preloadedPlugins: await this.routeLive(request, capabilities, evaluate),
    };
  }

  /** `on` mode: await the verdict, preload on it, fall open on anything else. */
  private async routeLive(
    request: CapabilityRouteRequest,
    capabilities: readonly RoutableCapability[],
    evaluate: () => Promise<DecisionEvaluation>,
  ): Promise<ReadonlySet<string>> {
    const startedAt = this.now();
    let evaluation: DecisionEvaluation;
    let verdict: CapabilityRouteVerdict;
    try {
      evaluation = await evaluate();
      verdict = decideCapabilityRoute(evaluation, capabilities);
    } catch (error) {
      if (error instanceof DecisionProviderUnavailableError) {
        this.warnUnavailable(request, 'on', error.name);
      } else {
        this.logger.warn(
          `${LOG_PREFIX} request=${request.requestId} mode=on status=fallback reason=${safeErrorType(error)}`,
        );
      }
      return NO_PRELOAD;
    }

    this.logger.log(
      [
        `${LOG_PREFIX} request=${request.requestId}`,
        'mode=on',
        'status=ok',
        `preloaded=${formatList(verdict.preload)}`,
        `candidates=${capabilities.length}`,
        ...verdictFields(verdict),
        `latencyMs=${this.now() - startedAt}`,
        ...provenanceFields(evaluation),
      ].join(' '),
    );
    return new Set(verdict.preload);
  }

  /**
   * `shadow` mode: start the evaluation and hand back a comparison handle.
   * The promise is NEVER awaited by the turn — shadow mode cannot delay or
   * change what the user gets. `Promise.resolve().then()` also turns a
   * synchronous failure inside `evaluate` into a shadow rejection.
   */
  private startShadow(
    request: CapabilityRouteRequest,
    capabilities: readonly RoutableCapability[],
    evaluate: () => Promise<DecisionEvaluation>,
  ): CapabilityRouteShadow {
    const startedAt = this.now();
    const prediction: Promise<CapabilityRouteVerdict | null> = Promise.resolve()
      .then(evaluate)
      .then((evaluation) => {
        const verdict = decideCapabilityRoute(evaluation, capabilities);
        this.logger.log(
          [
            `${SHADOW_LOG_PREFIX} request=${request.requestId}`,
            'status=ok',
            ...verdictFields(verdict),
            `wouldPreload=${formatList(verdict.preload)}`,
            `candidates=${capabilities.length}`,
            `latencyMs=${this.now() - startedAt}`,
            ...provenanceFields(evaluation),
          ].join(' '),
        );
        return verdict;
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `${SHADOW_LOG_PREFIX} request=${request.requestId} status=failed errorType=${safeErrorType(error)}`,
        );
        return null;
      });

    const priorLoaded = request.loadedPlugins;
    return {
      compare: (finalLoadedPlugins) => {
        const loadedDuringTurn = (finalLoadedPlugins ?? []).filter(
          (plugin) => !priorLoaded.has(plugin),
        );
        void prediction.then((verdict) => {
          if (verdict === null) return;
          const agree =
            verdict.preload.length === 0
              ? loadedDuringTurn.length === 0
              : verdict.preload.every((plugin) =>
                  loadedDuringTurn.includes(plugin),
                );
          this.logger.log(
            [
              `${SHADOW_LOG_PREFIX} request=${request.requestId}`,
              `wouldPreload=${formatList(verdict.preload)}`,
              `loadedDuringTurn=${formatList(loadedDuringTurn)}`,
              `agree=${String(agree)}`,
            ].join(' '),
          );
        });
      },
    };
  }

  /** The once-per-process warn for a router that cannot run at all. */
  private warnUnavailable(
    request: CapabilityRouteRequest,
    mode: Exclude<CapabilityRouterMode, 'off'>,
    reason: string,
  ): void {
    if (this.unavailableNoticeLogged) return;
    this.unavailableNoticeLogged = true;
    this.logger.warn(
      `${mode === 'on' ? LOG_PREFIX : SHADOW_LOG_PREFIX} request=${request.requestId} mode=${mode} status=fallback reason=${reason} (logged once per process)`,
    );
  }
}

/** Narrow the env value to a mode without asserting; unknown values are `off`. */
function parseMode(value: unknown): CapabilityRouterMode {
  return CAPABILITY_ROUTER_MODES.find((mode) => mode === value) ?? 'off';
}

/**
 * The plugins the router may pick from: on-demand (the default visibility)
 * and not yet loaded. `always` plugins are already bound and `silent` ones
 * are not agent-loadable, so a verdict naming either would be meaningless.
 */
function routableCandidates(
  manifests: readonly RegisteredManifest[],
  loadedPlugins: ReadonlySet<string>,
): RoutableCapability[] {
  return toRoutableCapabilities(
    manifests
      .filter(
        ({ pluginName, manifest }) =>
          (manifest.visibility ?? 'on-demand') === 'on-demand' &&
          !loadedPlugins.has(pluginName),
      )
      .map(({ pluginName, manifest }) => ({
        name: pluginName,
        title: manifest.title,
        summary: manifest.summary,
      })),
  );
}

/** The verdict as log fields — the same shape in the live and shadow lines. */
function verdictFields(verdict: CapabilityRouteVerdict): string[] {
  return [
    `needsCapability=${verdict.needsCapability}`,
    `capability=${verdict.capability ?? 'none'}`,
    ...(verdict.capabilityConfidence !== undefined
      ? [`capabilityConfidence=${verdict.capabilityConfidence}`]
      : []),
    `reason=${verdict.reason}`,
  ];
}

function provenanceFields(evaluation: DecisionEvaluation): string[] {
  return [
    `provider=${evaluation.provider}`,
    `model=${evaluation.model}`,
    ...(evaluation.modelVersion
      ? [`modelVersion=${evaluation.modelVersion}`]
      : []),
  ];
}

function formatList(items: readonly string[]): string {
  return `[${items.join(',')}]`;
}

/**
 * An error's type name and nothing else. Provider messages can echo Decision
 * state (which includes the user's text), so they never reach a log line.
 */
function safeErrorType(error: unknown): string {
  return error instanceof Error ? error.name || 'Error' : typeof error;
}
