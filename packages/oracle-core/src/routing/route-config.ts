import { z } from 'zod';

/**
 * Operator-declared semantic routes. A route's target is a REQUEST — the
 * kernel validates it against the loaded plugin set and the model policy at
 * boot, and the router grants it for one turn only. Routing never writes
 * graph state, so a classification can never become persistent authority.
 */
export const routeTargetSchema = z.object({
  /** Model role override for this turn (must exist in the model policy). */
  modelRole: z.string().min(1).optional(),
  /** Plugin capabilities exposed for THIS TURN only (must be loaded plugins). */
  loadCapabilities: z.array(z.string().min(1)).optional(),
  /** One-line delegation bias appended to the system prompt for this turn. */
  subAgentHint: z.string().min(1).optional(),
});

export const routeSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  /** Example utterances for the embedding strategy (and few-shot for llm). */
  exemplars: z.array(z.string().min(1)).max(32).optional(),
  target: routeTargetSchema,
});

export const routerConfigSchema = z.object({
  strategy: z.enum(['llm', 'embedding', 'off']).default('off'),
  routes: z.array(routeSchema).default([]),
  /**
   * Per-strategy acceptance thresholds — an LLM's self-reported confidence
   * and a cosine similarity live on different scales and are calibrated
   * separately.
   */
  minConfidence: z
    .object({
      llm: z.number().min(0).max(1).default(0.55),
      embedding: z.number().min(0).max(1).default(0.75),
    })
    .default({ llm: 0.55, embedding: 0.75 }),
  emitEvents: z.boolean().default(true),
});

export type RouterConfigInput = z.input<typeof routerConfigSchema>;
export type RouterConfig = z.output<typeof routerConfigSchema>;
export type Route = z.output<typeof routeSchema>;

/** Parse `ROUTER_CONFIG_JSON`; invalid JSON/shape fails boot loudly. */
export function parseRouterConfigEnv(
  raw: unknown,
): RouterConfigInput | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const parsed: unknown = JSON.parse(raw);
  return routerConfigSchema.parse(parsed);
}

/**
 * Validate route targets against what actually exists: capabilities must be
 * loaded plugins, model roles must be declared in the policy. A router that
 * can name unknown targets is a router that fails at request time instead
 * of boot.
 */
export function validateRouterConfig(
  config: RouterConfig,
  known: { availablePlugins: ReadonlySet<string>; policyRoles: Set<string> },
): string[] {
  const errors: string[] = [];
  for (const route of config.routes) {
    for (const capability of route.target.loadCapabilities ?? []) {
      if (!known.availablePlugins.has(capability)) {
        errors.push(
          `Route '${route.name}' targets capability '${capability}', which is not a loaded plugin.`,
        );
      }
    }
    if (
      route.target.modelRole &&
      !known.policyRoles.has(route.target.modelRole)
    ) {
      errors.push(
        `Route '${route.name}' targets model role '${route.target.modelRole}', which the model policy does not declare.`,
      );
    }
  }
  if (config.strategy !== 'off' && config.routes.length < 2) {
    errors.push(
      `Router strategy '${config.strategy}' requires at least two routes (got ${config.routes.length}).`,
    );
  }
  return errors;
}

/** A classifier's verdict for one turn. `null` = no route (safe default). */
export interface RouteDecision {
  route: Route;
  strategy: 'llm' | 'embedding';
  confidence: number;
}

/** Strategy function contract — injected so the middleware stays pure. */
export type RouteClassifier = (input: {
  text: string;
}) => Promise<RouteDecision | null>;
