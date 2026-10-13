import { DecisionProviderUnavailableError } from './errors.js';
import type { DecisionAdapter, DecisionProviderSelection } from './types.js';

/**
 * One configured Decision provider. `id` names the configured instance (for
 * example `cloudflare-jev` or `semif-local`); it is what policies route to and
 * what evaluations record as `providerId`. `adapter.provider` stays the engine
 * name, so two instances of one engine are told apart by id.
 */
export interface DecisionProviderRegistration {
  readonly id: string;
  readonly adapter: DecisionAdapter;
}

/**
 * Provider id of a single adapter handed to the runtime directly (a bare
 * `DecisionRuntime` adapter, `createOracleWorker({ decisionAdapter })`). That
 * provider is also the configured default.
 */
export const HOST_DECISION_PROVIDER_ID = 'host';

export class DecisionProviderNotFoundError extends Error {
  constructor(
    readonly providerId: string,
    readonly availableProviderIds: readonly string[],
  ) {
    super(
      availableProviderIds.length === 0
        ? `Decision provider "${providerId}" is not registered; no providers are configured.`
        : `Decision provider "${providerId}" is not registered. Available providers: ${availableProviderIds.join(', ')}.`,
    );
    this.name = 'DecisionProviderNotFoundError';
  }
}

/**
 * Several providers are configured and neither a route nor a default names
 * one for this Decision. A subclass of `DecisionProviderUnavailableError`, so
 * callers that already fail open on a missing provider (the capability
 * router) treat an unresolvable configuration the same way.
 */
export class AmbiguousDecisionProviderError extends DecisionProviderUnavailableError {
  constructor(
    readonly decisionName: string,
    readonly providerIds: readonly string[],
  ) {
    super(
      `No Decision provider is selected for "${decisionName}": providers ${providerIds.join(', ')} are configured without a route or a default. Set decisionProviderPolicy.defaultProviderId or a route for this Decision.`,
    );
    this.name = 'AmbiguousDecisionProviderError';
  }
}

export class DecisionProviderRegistry {
  private readonly providers = new Map<string, DecisionProviderRegistration>();

  constructor(registrations: readonly DecisionProviderRegistration[] = []) {
    for (const registration of registrations) this.register(registration);
  }

  get size(): number {
    return this.providers.size;
  }

  register(registration: DecisionProviderRegistration): void {
    const id = registration.id.trim();
    if (!id) {
      throw new TypeError('Decision provider id must be a non-empty string.');
    }
    if (this.providers.has(id)) {
      throw new Error(`Decision provider "${id}" is already registered.`);
    }
    this.providers.set(id, { id, adapter: registration.adapter });
  }

  get(id: string): DecisionProviderRegistration | undefined {
    return this.providers.get(id);
  }

  require(id: string): DecisionProviderRegistration {
    const provider = this.providers.get(id);
    if (provider) return provider;
    throw new DecisionProviderNotFoundError(id, [...this.providers.keys()]);
  }

  /** Registrations in registration order. */
  list(): readonly DecisionProviderRegistration[] {
    return [...this.providers.values()];
  }
}

export interface DecisionProviderPolicy {
  /** Provider used when neither a caller override nor a route applies. */
  readonly defaultProviderId?: string;
  /** Exact Decision name → configured provider id. */
  readonly routes?: Readonly<Record<string, string>>;
}

export interface DecisionProviderResolution {
  readonly provider: DecisionProviderRegistration;
  readonly selectedBy: DecisionProviderSelection;
}

/**
 * Deterministic provider selection. Precedence: the caller's `providerId`,
 * the exact per-Decision route, the policy default, then the only registered
 * provider. With several providers and none of those, selection is refused
 * rather than falling to registration order. Selection never grants
 * authority, and a provider failure never falls through to another provider.
 */
export class DecisionProviderRouter {
  constructor(
    private readonly registry: DecisionProviderRegistry,
    private readonly policy: DecisionProviderPolicy = {},
  ) {
    // Fail at construction (boot) on a policy naming an unknown provider,
    // instead of on the first evaluation that happens to hit it.
    if (policy.defaultProviderId !== undefined) {
      registry.require(policy.defaultProviderId);
    }
    for (const providerId of Object.values(policy.routes ?? {})) {
      registry.require(providerId);
    }
  }

  /**
   * Resolves the provider for one evaluation. `undefined` means no provider
   * is configured at all. Throws `DecisionProviderNotFoundError` for an
   * unknown override and `AmbiguousDecisionProviderError` when several
   * providers are configured but none is selected for `decisionName`.
   */
  resolve(
    decisionName: string,
    providerId?: string,
  ): DecisionProviderResolution | undefined {
    if (providerId !== undefined) {
      return {
        provider: this.registry.require(providerId),
        selectedBy: 'caller-override',
      };
    }

    const routes = this.policy.routes;
    if (routes && Object.prototype.hasOwnProperty.call(routes, decisionName)) {
      const routedProviderId = routes[decisionName];
      if (routedProviderId !== undefined) {
        return {
          provider: this.registry.require(routedProviderId),
          selectedBy: 'decision-route',
        };
      }
    }

    if (this.policy.defaultProviderId !== undefined) {
      return {
        provider: this.registry.require(this.policy.defaultProviderId),
        selectedBy: 'default',
      };
    }

    const providers = this.registry.list();
    const [sole] = providers;
    if (providers.length === 1 && sole) {
      return { provider: sole, selectedBy: 'sole-provider' };
    }
    if (providers.length === 0) return undefined;

    throw new AmbiguousDecisionProviderError(
      decisionName,
      providers.map((provider) => provider.id),
    );
  }
}
