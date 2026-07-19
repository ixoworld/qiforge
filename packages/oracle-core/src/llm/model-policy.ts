import { z } from 'zod';

/**
 * Operator-governed model policy: which model serves each role, through
 * which provider adapter, under which constraints. Policy is DATA — layered
 * from built-in defaults, the `MODEL_POLICY_JSON` env, and the host's
 * `createOracleApp` option (the config-document loader will feed the same
 * slot) — never a source-code table a fork must republish to change.
 *
 * Credentials never appear here: targets carry opaque `credentialRef`
 * values resolved by the boot-registered credential broker, so a
 * configuration document can name a credential but can neither mint one
 * nor point the runtime at an arbitrary environment variable.
 */
export const modelTargetSchema = z.object({
  /** Provider-adapter name (must be registered; unknown names fail boot). */
  provider: z.string().min(1).optional(),
  model: z.string().min(1),
  /** Opaque credential reference resolved by the broker. */
  credentialRef: z.string().min(1).optional(),
  /** Extra ChatOpenAI-style params (temperature, reasoning, modelKwargs). */
  params: z.record(z.string(), z.unknown()).optional(),
});
export type ModelTargetInput = z.infer<typeof modelTargetSchema>;

/**
 * A fallback is a deliberate, disclosed policy decision — off unless the
 * operator declares one, and every entry names what changes when it fires.
 */
export const modelFallbackSchema = z.object({
  model: z.string().min(1),
  provider: z.string().min(1).optional(),
  disclosure: z.object({
    reason: z.string().min(1),
    residencyChange: z.string().optional(),
    retentionChange: z.string().optional(),
    costChange: z.string().optional(),
  }),
});

/**
 * Cloudflare AI Gateway as TRANSPORT, not provider: when configured, the
 * selected provider adapter's traffic is routed through the gateway URL
 * with the gateway auth header. `mode` records credential custody: pooled
 * (host keys, custodial) vs byok (operator keys in the gateway's store).
 */
export const aiGatewayTransportSchema = z.object({
  accountId: z.string().min(1),
  gatewayId: z.string().min(1),
  mode: z.enum(['pooled', 'byok']).default('pooled'),
  urlStyle: z.enum(['compat', 'provider']).default('compat'),
  /** Broker ref for the `cf-aig-authorization` token. */
  authTokenRef: z.string().min(1),
  /** Pooled mode: broker ref for the upstream provider key sent with requests. */
  providerKeyRef: z.string().min(1).optional(),
});
export type AiGatewayTransportInput = z.infer<typeof aiGatewayTransportSchema>;

export const modelConstraintsSchema = z.object({
  /** Providers routing may select from. Empty/absent = the declared targets' providers. */
  allowedProviders: z.array(z.string()).optional(),
  /** Models routing may select from. Empty/absent = the declared targets' models. */
  allowedModels: z.array(z.string()).optional(),
});

export const modelPolicySchema = z.object({
  version: z.literal(1).default(1),
  defaultProvider: z.string().min(1).default('openrouter'),
  gateway: aiGatewayTransportSchema.optional(),
  roles: z.record(z.string(), modelTargetSchema).default({}),
  fallbacks: z.record(z.string(), z.array(modelFallbackSchema)).default({}),
  constraints: modelConstraintsSchema.default({}),
});
export type ModelPolicyInput = z.input<typeof modelPolicySchema>;
export type ModelPolicyResolved = z.output<typeof modelPolicySchema>;

/** A role resolved to its concrete target (post-layering, post-defaults). */
export interface ResolvedModelTarget {
  role: string;
  provider: string;
  model: string;
  credentialRef?: string;
  params?: Record<string, unknown>;
  gateway?: z.output<typeof aiGatewayTransportSchema>;
  fallbacks: Array<z.output<typeof modelFallbackSchema>>;
}

export class ModelPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelPolicyError';
  }
}

export interface ModelPolicy {
  /** Resolve a role. UNKNOWN ROLES THROW — silent downgrades hide config errors. */
  targetFor(role: string): ResolvedModelTarget;
  /** Roles the policy declares. */
  roles(): string[];
  /** Throws when a proposed (provider, model) pair falls outside the constraint set. */
  assertWithinConstraints(provider: string, model: string): void;
  readonly resolved: ModelPolicyResolved;
}

/** Deep-merge policy layers, later layers winning per role/field. */
export function buildModelPolicy(
  layers: Array<ModelPolicyInput | undefined>,
): ModelPolicy {
  const merged: ModelPolicyResolved = modelPolicySchema.parse({});
  for (const layer of layers) {
    if (!layer) continue;
    const parsed = modelPolicySchema.parse(layer);
    merged.defaultProvider = layer.defaultProvider ?? merged.defaultProvider;
    merged.gateway = parsed.gateway ?? merged.gateway;
    merged.roles = { ...merged.roles, ...parsed.roles };
    merged.fallbacks = { ...merged.fallbacks, ...parsed.fallbacks };
    merged.constraints = {
      allowedProviders:
        parsed.constraints.allowedProviders ??
        merged.constraints.allowedProviders,
      allowedModels:
        parsed.constraints.allowedModels ?? merged.constraints.allowedModels,
    };
  }

  const declaredProviders = new Set<string>();
  const declaredModels = new Set<string>();
  for (const target of Object.values(merged.roles)) {
    declaredProviders.add(target.provider ?? merged.defaultProvider);
    declaredModels.add(target.model);
  }

  const allowedProviders = new Set(
    merged.constraints.allowedProviders ?? [...declaredProviders],
  );
  const allowedModels = new Set(
    merged.constraints.allowedModels ?? [...declaredModels],
  );

  const assertWithinConstraints = (provider: string, model: string): void => {
    if (!allowedProviders.has(provider)) {
      throw new ModelPolicyError(
        `Provider '${provider}' is outside the operator's allowed set (${[...allowedProviders].join(', ')}).`,
      );
    }
    if (!allowedModels.has(model)) {
      throw new ModelPolicyError(
        `Model '${model}' is outside the operator's allowed set.`,
      );
    }
  };

  return {
    resolved: merged,
    roles: () => Object.keys(merged.roles),
    assertWithinConstraints,
    targetFor(role) {
      const target = merged.roles[role];
      if (!target) {
        throw new ModelPolicyError(
          `Model role '${role}' is not declared in the model policy. ` +
            `Declared roles: ${Object.keys(merged.roles).join(', ') || '(none)'}. ` +
            `Unknown roles fail loudly instead of silently downgrading.`,
        );
      }
      const provider = target.provider ?? merged.defaultProvider;
      const fallbacks = merged.fallbacks[role] ?? [];
      for (const fallback of fallbacks) {
        assertWithinConstraints(fallback.provider ?? provider, fallback.model);
      }
      assertWithinConstraints(provider, target.model);
      return {
        role,
        provider,
        model: target.model,
        credentialRef: target.credentialRef,
        params: target.params,
        gateway: merged.gateway,
        fallbacks,
      };
    },
  };
}

/** Parse the `MODEL_POLICY_JSON` env value; invalid JSON/shape fails boot loudly. */
export function parseModelPolicyEnv(
  raw: unknown,
): ModelPolicyInput | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const parsed: unknown = JSON.parse(raw);
  return modelPolicySchema.parse(parsed);
}
