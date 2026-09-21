import type { DecisionProviderSelection } from '@ixo/common';
import {
  DecisionProviderRegistry,
  type DecisionProviderRegistration,
} from './provider-registry.js';

export interface DecisionProviderPolicy {
  /** Provider used when no per-Decision route or caller override applies. */
  readonly defaultProviderId?: string;
  /** Exact Decision name → configured provider id. */
  readonly routes?: Readonly<Record<string, string>>;
}

export interface DecisionProviderResolution {
  readonly provider: DecisionProviderRegistration;
  readonly selectedBy: DecisionProviderSelection;
}

export class DecisionProviderRouter {
  constructor(
    private readonly registry: DecisionProviderRegistry,
    private readonly policy: DecisionProviderPolicy = {},
  ) {
    this.assertPolicyReferences();
  }

  resolve(
    decisionName: string,
    providerId?: string,
  ): DecisionProviderResolution | undefined {
    if (providerId) {
      return {
        provider: this.registry.require(providerId),
        selectedBy: 'caller-override',
      };
    }

    const routedProviderId = this.policy.routes?.[decisionName];
    if (routedProviderId) {
      return {
        provider: this.registry.require(routedProviderId),
        selectedBy: 'decision-route',
      };
    }

    if (this.policy.defaultProviderId) {
      return {
        provider: this.registry.require(this.policy.defaultProviderId),
        selectedBy: 'default',
      };
    }

    if (this.registry.size === 1) {
      return {
        provider: this.registry.list()[0]!,
        selectedBy: 'default',
      };
    }

    return undefined;
  }

  list(): readonly DecisionProviderRegistration[] {
    return this.registry.list();
  }

  private assertPolicyReferences(): void {
    if (this.policy.defaultProviderId) {
      this.registry.require(this.policy.defaultProviderId);
    }
    for (const providerId of Object.values(this.policy.routes ?? {})) {
      this.registry.require(providerId);
    }
  }
}
