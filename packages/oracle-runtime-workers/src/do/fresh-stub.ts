/**
 * A Durable Object stub that never goes stale.
 *
 * A stub is a connection to one incarnation of the target object: once that
 * object restarts (deploy, eviction, memory reset, `restart()`), calls on the
 * old stub fail with "Network connection lost" until the CALLER is itself
 * recreated. The user object keeps one gateway handle for its whole life and
 * hands it to long-lived helpers (owner store, preferences, status card,
 * ambient matrix adapter), so a single gateway restart silently degraded
 * every best-effort gateway call for hours.
 *
 * `freshStub` returns a proxy with the stub's interface whose every property
 * access resolves against a NEW stub from `get()` — `namespace.get(id)` is a
 * local, allocation-only operation, so this costs nothing per call and each
 * RPC lands on whatever incarnation is current.
 */
export function freshStub<T extends object>(get: () => T): T {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      // Hand the property back untouched: an RPC property carries its own
      // target, and touching it in any other way (e.g. `.bind`) is itself
      // treated as an RPC call by the runtime ("The RPC receiver does not
      // implement the method \"bind\"").
      const stub = get();
      return Reflect.get(stub, prop, stub) as unknown;
    },
    has(_target, prop) {
      return Reflect.has(get(), prop);
    },
  };
  return new Proxy({}, handler) as T;
}
