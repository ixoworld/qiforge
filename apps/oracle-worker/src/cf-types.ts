/**
 * Minimal STRUCTURAL slices of the workerd runtime types this compile spike
 * touches. Deliberately local: the spike's whole point is that
 * `@ixo/oracle-core` + this entry compile with no platform packages at all
 * (no `@cloudflare/workers-types`, no `nodejs_compat`). The Phase 5 adapter
 * replaces these with the real generated types.
 */
export interface SpikeExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface SpikeDurableObjectState {
  id: { toString(): string };
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };
}

/** Bindings the spike's wrangler.toml declares. */
export interface SpikeEnv {
  ORACLE_SESSION: unknown;
}
