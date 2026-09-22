import {
  CAPABILITY_ROUTER_MODES,
  DecisionProviderUnavailableError,
  capabilityRouteDecision,
  decideCapabilityRoute,
  toRoutableCapabilities,
  type CapabilityRouterMode,
  type DecisionEvaluator,
  type RoutableCapability,
} from '@ixo/common/ai/decisions';
import type { Logger } from '../plugin-api/types';
import type { RegisteredManifest } from './registries';

/**
 * Predicts, before the first model call of a turn, which on-demand plugin the
 * user's message needs and preloads that plugin's tools for the turn, so the
 * model does not spend a round trip on `load_capability`.
 *
 * The preload is one-turn state only: it is admitted by the capability gate
 * and visible as loaded to tool handlers, but never written to the graph's
 * `loadedPlugins` channel. The router fails open — any evaluation failure
 * preloads nothing and the turn proceeds exactly as without a router.
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
  /** Every registered manifest; the router picks the routable candidates. */
  manifests: readonly RegisteredManifest[];
  /** Plugins the thread has already loaded (the checkpointed channel). */
  loaded: ReadonlySet<string>;
  /** The user's message text for this turn. */
  text: string;
  requestId: string;
  /** The turn's abort signal; only an awaited (`on`) evaluation is bound to it. */
  signal?: AbortSignal;
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

/**
 * The manifests the router may choose from: effectively on-demand plugins the
 * thread has not loaded yet. `always` plugins are already bound and `silent`
 * ones are never surfaced, so predicting them is pointless.
 */
export function routableCandidates(
  manifests: readonly RegisteredManifest[],
  loaded: ReadonlySet<string>,
): RoutableCapability[] {
  return toRoutableCapabilities(
    manifests
      .filter(
        ({ pluginName, manifest }) =>
          (manifest.visibility ?? 'on-demand') === 'on-demand' &&
          !loaded.has(pluginName),
      )
      .map(({ pluginName, manifest }) => ({
        name: pluginName,
        title: manifest.title,
        summary: manifest.summary,
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

  const unavailable = (error: unknown): boolean =>
    error instanceof DecisionProviderUnavailableError;

  const warnUnavailable = (requestId: string, mode: CapabilityRouterMode) => {
    if (unavailableWarned) return;
    unavailableWarned = true;
    logger.warn(
      `[capability-router] request=${requestId} mode=${mode} status=fallback reason=DecisionProviderUnavailableError (set DECISION_PROVIDER or CAPABILITY_ROUTER=off)`,
    );
  };

  return async (turn) => {
    if (turn.mode === 'off') return NOTHING;
    const text = turn.text.trim();
    if (!text) return NOTHING;
    const capabilities = routableCandidates(turn.manifests, turn.loaded);
    if (capabilities.length === 0) return NOTHING;

    // The turn is prepared from a checkpoint read without its messages, so
    // the router sees the current message only; `recentTurns` stays empty.
    const input = { text, recentTurns: [], capabilities };
    const { requestId } = turn;

    if (turn.mode === 'shadow') {
      const started = now();
      background(
        evaluator
          .evaluate(capabilityRouteDecision, input)
          .then((evaluation) => {
            const verdict = decideCapabilityRoute(evaluation, capabilities);
            logger.log(
              `[capability-router-shadow] request=${requestId} status=ok ` +
                `needsCapability=${verdict.needsCapability.toFixed(2)} ` +
                `capability=${verdict.capability ?? '-'} ` +
                `capabilityConfidence=${verdict.capabilityConfidence?.toFixed(2) ?? '-'} ` +
                `wouldPreload=${list(verdict.preload)} reason=${verdict.reason} ` +
                `latencyMs=${now() - started} provider=${evaluation.provider} model=${evaluation.model}`,
            );
            turn.onShadowVerdict?.(verdict.preload);
          })
          .catch((error: unknown) => {
            if (unavailable(error)) {
              warnUnavailable(requestId, 'shadow');
              return;
            }
            logger.log(
              `[capability-router-shadow] request=${requestId} status=failed errorType=${errorName(error)} latencyMs=${now() - started}`,
            );
          }),
      );
      return NOTHING;
    }

    try {
      const evaluation = await evaluator.evaluate(
        capabilityRouteDecision,
        input,
        turn.signal ? { signal: turn.signal } : undefined,
      );
      const verdict = decideCapabilityRoute(evaluation, capabilities);
      if (verdict.preload.length === 0) {
        logger.debug?.(
          `[capability-router] request=${requestId} mode=on status=none reason=${verdict.reason} candidates=${capabilities.length}`,
        );
        return NOTHING;
      }
      logger.log(
        `[capability-router] request=${requestId} preloaded=${list(verdict.preload)} candidates=${capabilities.length}`,
      );
      return new Set(verdict.preload);
    } catch (error) {
      if (unavailable(error)) {
        warnUnavailable(requestId, 'on');
      } else {
        logger.warn(
          `[capability-router] request=${requestId} mode=on status=fallback reason=${errorName(error)}`,
        );
      }
      return NOTHING;
    }
  };
}
