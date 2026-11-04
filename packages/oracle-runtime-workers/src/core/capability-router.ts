import {
  AmbiguousDecisionProviderError,
  CAPABILITY_PRELOAD_BATCH_SIZE,
  CAPABILITY_PRELOAD_WARM_THRESHOLD,
  CAPABILITY_ROUTER_MODES,
  CAPABILITY_ROUTE_DECISION_NAME,
  DecisionProviderUnavailableError,
  capabilityPreloadDecision,
  decideCapabilityPreload,
  toRoutableCapabilities,
  type CapabilityPreloadVerdict,
  type CapabilityRouterMode,
  type DecisionEvaluateOptions,
  type DecisionEvaluator,
  type DecisionTraceOptions,
  type RoutableCapability,
} from '@ixo/common/ai/decisions';
import type { Logger, PluginManifest } from '../plugin-api/types';
import type { RegisteredManifest } from './registries';

/**
 * Predicts, before the first model call of a turn, every plugin the user's
 * message needs from what is left to load, so the model does not spend a
 * round trip on `load_capability`. A plugin it misses is still one
 * `load_capability` away.
 *
 * A preload is a normal load: the turn writes it to the graph's
 * `loadedPlugins` channel and it stays until a cold turn unloads it, so the
 * tool list changes once. It costs the cache miss a `load_capability` would,
 * without the extra call. On a turn the provider's cache has lost anyway it
 * costs no miss at all, which is why a warm turn asks for a higher score
 * (`CAPABILITY_ROUTER_WARM_THRESHOLD`). The router fails open — any evaluation
 * failure preloads nothing and the turn proceeds exactly as without a router.
 */
export interface CapabilityRouterOptions {
  evaluator: DecisionEvaluator;
  logger: Logger;
  /**
   * Keeps a shadow evaluation alive after the turn has moved on
   * (`ctx.waitUntil` on Workers). Without it the promise is merely detached.
   */
  background?: (work: Promise<unknown>) => void;
  now?: () => number;
}

export interface CapabilityRouteTurn {
  mode: CapabilityRouterMode;
  /**
   * What a `load_capability` could load right now (`createMainAgent` works
   * this out from the turn's own tools): the plugins with an on-demand tool
   * the thread has not loaded, `always` ones with `onDemandTools` included,
   * that the user's delegation may use.
   */
  candidates: readonly RegisteredManifest[];
  /** The score a preload needs; the calibration profile's when omitted. */
  threshold?: number;
  /** The user's message text for this turn. */
  text: string;
  /**
   * The thread's latest visible turns, oldest first, so a follow-up such as
   * "send half to Bob" can be routed. Called only when the router evaluates;
   * when it fails the router evaluates the message alone.
   */
  recentTurns?: () => Promise<readonly string[]>;
  requestId: string;
  /** The turn's abort signal; only an awaited (`on`) evaluation is bound to it. */
  signal?: AbortSignal;
  /**
   * The turn's tracer and trace metadata. The router runs before the graph,
   * outside any LangChain run, so without these its Decision is not traced.
   */
  trace?: DecisionTraceOptions;
  /**
   * Shadow mode only: receives what the router would have preloaded once its
   * evaluation completes, so the host can compare it with what the turn
   * actually loaded.
   */
  onShadowVerdict?: (wouldPreload: readonly string[]) => void;
}

export type CapabilityRouter = (
  turn: CapabilityRouteTurn,
) => Promise<ReadonlySet<string>>;

const NOTHING: ReadonlySet<string> = new Set<string>();

/** Narrows an env value to a router mode; anything else is `off`. */
export function capabilityRouterMode(value: unknown): CapabilityRouterMode {
  return CAPABILITY_ROUTER_MODES.find((mode) => mode === value) ?? 'off';
}

/** The score a preload needs this turn: the operator's, else the default. */
export function preloadThreshold(
  cold: boolean,
  env: {
    CAPABILITY_ROUTER_COLD_THRESHOLD?: unknown;
    CAPABILITY_ROUTER_WARM_THRESHOLD?: unknown;
  },
): { threshold?: number } {
  const set = cold
    ? env.CAPABILITY_ROUTER_COLD_THRESHOLD
    : env.CAPABILITY_ROUTER_WARM_THRESHOLD;
  if (typeof set === 'number') return { threshold: set };
  return cold ? {} : { threshold: CAPABILITY_PRELOAD_WARM_THRESHOLD };
}

/**
 * What the router reads about a plugin: its summary and the `whenToUse` lines
 * the manifest already carries. The summary alone often leaves out what a
 * plugin does ("retire tokens", "cancel a reminder"), and a yes/no question
 * then scores far below the preload threshold.
 */
function routingSummary(manifest: PluginManifest): string {
  return manifest.whenToUse.length > 0
    ? `${manifest.summary} Use when: ${manifest.whenToUse.join(' ')}`
    : manifest.summary;
}

/** The Decision's view of the candidates. */
export function routableCandidates(
  candidates: readonly RegisteredManifest[],
): RoutableCapability[] {
  return toRoutableCapabilities(
    candidates.map(({ pluginName, manifest }) => ({
      name: pluginName,
      title: manifest.title,
      summary: routingSummary(manifest),
    })),
  );
}

/**
 * After-turn comparison for shadow mode: which plugins the turn loaded on its
 * own, and whether that matches what the router would have preloaded.
 */
export function shadowAgreement(args: {
  priorLoaded: ReadonlySet<string>;
  loadedAfter: ReadonlySet<string>;
  wouldPreload: readonly string[];
}): { loadedDuringTurn: string[]; agree: boolean } {
  const loadedDuringTurn = Array.from(args.loadedAfter).filter(
    (name) => !args.priorLoaded.has(name),
  );
  const predicted = new Set(args.wouldPreload);
  const agree =
    predicted.size === loadedDuringTurn.length &&
    loadedDuringTurn.every((name) => predicted.has(name));
  return { loadedDuringTurn, agree };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function list(names: readonly string[]): string {
  return `[${names.join(', ')}]`;
}

/** The likeliest candidates, for refitting the threshold from real traffic. */
function topScores(verdict: CapabilityPreloadVerdict): string {
  return verdict.scores
    .slice(0, 3)
    .map(({ name, probability }) => `${name}:${probability.toFixed(2)}`)
    .join(',');
}

/** Splits candidates into lists one Decision request can carry. */
function batches<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

export function createCapabilityRouter(
  options: CapabilityRouterOptions,
): CapabilityRouter {
  const { evaluator, logger } = options;
  const now = options.now ?? (() => Date.now());
  const background =
    options.background ??
    ((work: Promise<unknown>) => {
      void work;
    });
  // A missing Decision provider is a deployment fact, not a per-turn event:
  // said once per object, then the router stays quiet.
  let unavailableWarned = false;

  // An ambiguous multi-provider configuration is a subclass: equally a
  // deployment fact, but fixed by routing rather than by adding a provider.
  const unavailable = (
    error: unknown,
  ): error is DecisionProviderUnavailableError =>
    error instanceof DecisionProviderUnavailableError;

  const warnUnavailable = (
    requestId: string,
    mode: CapabilityRouterMode,
    error: DecisionProviderUnavailableError,
  ) => {
    if (unavailableWarned) return;
    unavailableWarned = true;
    const hint =
      error instanceof AmbiguousDecisionProviderError
        ? `route ${CAPABILITY_ROUTE_DECISION_NAME} or set decisionProviderPolicy.defaultProviderId`
        : 'set DECISION_PROVIDER or CAPABILITY_ROUTER=off';
    logger.warn(
      `[capability-router] request=${requestId} mode=${mode} status=fallback reason=${error.name} (${hint})`,
    );
  };

  return async (turn) => {
    if (turn.mode === 'off') return NOTHING;
    // No score reaches it: nothing to spend a Decision on.
    if ((turn.threshold ?? 0) > 1) return NOTHING;
    const text = turn.text.trim();
    if (!text) return NOTHING;
    const capabilities = routableCandidates(turn.candidates);
    if (capabilities.length === 0) return NOTHING;

    const { requestId } = turn;
    let recentTurns: string[] = [];
    const evaluateAll = async (options?: DecisionEvaluateOptions) => {
      try {
        recentTurns = [...((await turn.recentTurns?.()) ?? [])];
      } catch (error) {
        logger.warn(
          `[capability-router] request=${requestId} mode=${turn.mode} status=degraded reason=${errorName(error)} (recent turns unavailable)`,
        );
      }
      return Promise.all(
        batches(capabilities, CAPABILITY_PRELOAD_BATCH_SIZE).map((batch) =>
          evaluator.evaluate(
            capabilityPreloadDecision,
            { text, recentTurns, capabilities: batch },
            options,
          ),
        ),
      );
    };

    if (turn.mode === 'shadow') {
      const started = now();
      background(
        evaluateAll(turn.trace)
          .then((evaluations) => {
            const verdict = decideCapabilityPreload(
              evaluations,
              capabilities,
              turn.threshold,
            );
            logger.log(
              `[capability-router-shadow] request=${requestId} status=ok ` +
                `top=${topScores(verdict)} ` +
                `wouldPreload=${list(verdict.preload)} ` +
                `threshold=${turn.threshold ?? 'profile'} ` +
                `calibrationProfile=${verdict.calibrationProfileRef ?? '-'} ` +
                `latencyMs=${now() - started} provider=${evaluations[0]?.provider} model=${evaluations[0]?.model}`,
            );
            turn.onShadowVerdict?.(verdict.preload);
          })
          .catch((error: unknown) => {
            if (unavailable(error)) {
              warnUnavailable(requestId, 'shadow', error);
              return;
            }
            logger.log(
              `[capability-router-shadow] request=${requestId} status=failed errorType=${errorName(error)} latencyMs=${now() - started}`,
            );
          }),
      );
      return NOTHING;
    }

    const started = now();
    try {
      const evaluations = await evaluateAll({
        ...turn.trace,
        ...(turn.signal && { signal: turn.signal }),
      });
      const verdict = decideCapabilityPreload(
        evaluations,
        capabilities,
        turn.threshold,
      );
      logger.log(
        `[capability-router] request=${requestId} mode=on status=${verdict.preload.length > 0 ? 'ok' : 'none'} ` +
          `preloaded=${list(verdict.preload)} top=${topScores(verdict)} threshold=${turn.threshold ?? 'profile'} ` +
          `candidates=${capabilities.length} recentTurns=${recentTurns.length} latencyMs=${now() - started}`,
      );
      if (verdict.preload.length === 0) return NOTHING;
      return new Set(verdict.preload);
    } catch (error) {
      if (unavailable(error)) {
        warnUnavailable(requestId, 'on', error);
      } else {
        logger.warn(
          `[capability-router] request=${requestId} mode=on status=fallback reason=${errorName(error)}`,
        );
      }
      return NOTHING;
    }
  };
}
