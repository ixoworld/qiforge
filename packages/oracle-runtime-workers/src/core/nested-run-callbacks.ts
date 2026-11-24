/**
 * Callbacks for a model or agent invoked inside one of the turn's runs (a
 * sub-agent inside its tool call, a helper model inside a plugin tool).
 *
 * On Workers nothing hands a run's callbacks to a nested invocation on its
 * own: LangChain does that through AsyncLocalStorage, which its web build
 * (the one Wrangler bundles) never sets up. A nested `invoke` without
 * `callbacks` therefore starts a tree of its own that no tracer of the turn
 * sees: its model calls were missing from IXO Traces and LangSmith.
 *
 * `nestedRunCallbacks(config.callbacks)` gives the nested invocation the
 * enclosing run's callback manager (its runs become children of that run)
 * with only the handlers marked `inheritedByNestedRuns`: the turn's tracers
 * (IXO Traces, LangSmith) and its meter. Every other handler stays behind,
 * above all the turn's event stream (`streamEvents`), so a nested run's
 * tokens and tool calls never reach the person's reply stream or its tool
 * cards.
 *
 * The meter dedupes by run id (`ModelCallReports`): a call it sees both on
 * the model's own callbacks and here is counted once.
 */
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { CallbackManager } from '@langchain/core/callbacks/manager';

const inherited = new WeakSet<object>();

/** Mark `handler` as one a nested invocation keeps (a tracer, the meter). */
export function inheritedByNestedRuns<T extends BaseCallbackHandler>(
  handler: T,
): T {
  inherited.add(handler);
  return handler;
}

function isManager(value: unknown): value is CallbackManager {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'copy') === 'function' &&
    typeof Reflect.get(value, 'removeHandler') === 'function' &&
    Array.isArray(Reflect.get(value, 'handlers'))
  );
}

/**
 * The callbacks a nested invocation passes on, from the enclosing run's
 * (`config.callbacks` of a tool or node). Undefined when there is no
 * enclosing run (a plain handler list has no parent run to nest under, and
 * would start a tree of its own).
 */
export function nestedRunCallbacks(
  callbacks: unknown,
): CallbackManager | undefined {
  if (!isManager(callbacks)) return undefined;
  const manager = callbacks.copy();
  for (const handler of [...manager.handlers])
    if (!inherited.has(handler)) manager.removeHandler(handler);
  return manager;
}
