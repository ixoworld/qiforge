import type { DecisionAdapter } from '@ixo/common';

export interface DecisionProviderRegistration {
  /** Stable configured-provider identity (for example `cloudflare-jev`). */
  readonly id: string;
  readonly adapter: DecisionAdapter;
}

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
    this.providers.set(id, { ...registration, id });
  }

  get(id: string): DecisionProviderRegistration | undefined {
    return this.providers.get(id);
  }

  require(id: string): DecisionProviderRegistration {
    const provider = this.get(id);
    if (provider) return provider;
    throw new DecisionProviderNotFoundError(
      id,
      this.list().map((entry) => entry.id),
    );
  }

  list(): readonly DecisionProviderRegistration[] {
    return [...this.providers.values()];
  }
}
