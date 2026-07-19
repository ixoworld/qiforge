import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import { sha256Hex } from '../kernel/audit.js';
import type {
  Route,
  RouteClassifier,
  RouteDecision,
  RouterConfig,
} from './route-config.js';

/**
 * LLM strategy: structured single-token-ish classification at temperature 0
 * with self-reported confidence. Note for operators: this sends the user's
 * turn text to the routing model — selecting the strategy IS the opt-in to
 * that extra processor.
 */
export function createLlmRouteClassifier(options: {
  model: BaseChatModel;
  config: RouterConfig;
}): RouteClassifier {
  const { model, config } = options;
  const names = config.routes.map((r) => r.name);
  const byName = new Map(config.routes.map((r) => [r.name, r]));
  const schema = z.object({
    route: z.enum(['none', ...names] as [string, ...string[]]),
    confidence: z.number().min(0).max(1),
  });

  const catalogue = config.routes
    .map((r) => {
      const exemplars = (r.exemplars ?? [])
        .slice(0, 4)
        .map((e) => `    e.g. "${e}"`)
        .join('\n');
      return `- ${r.name}: ${r.description}${exemplars ? `\n${exemplars}` : ''}`;
    })
    .join('\n');

  return async ({ text }) => {
    const structured = model.withStructuredOutput(schema);
    const result = await structured.invoke([
      {
        role: 'system',
        content:
          'Classify the user message into exactly one of these routes, or "none" when nothing clearly applies.\n' +
          `${catalogue}\n` +
          'Respond with the route name and your confidence (0-1). Prefer "none" over guessing.',
      },
      { role: 'user', content: text },
    ]);
    if (result.route === 'none') return null;
    const route = byName.get(result.route);
    if (!route) return null;
    if (result.confidence < config.minConfidence.llm) return null;
    return { route, strategy: 'llm', confidence: result.confidence };
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface ExemplarIndex {
  digest: string;
  vectors: Array<{ route: Route; vector: number[] }>;
}

/**
 * Embedding strategy: cosine top-1 over operator-declared exemplars. The
 * exemplar index is memoized per route-set digest AND embedder identity —
 * changing either rebuilds it (embedding spaces are not interchangeable).
 */
export function createEmbeddingRouteClassifier(options: {
  embed: (texts: string[]) => Promise<number[][]>;
  /** Identity of the embedding space (model id + dims); part of the cache key. */
  embedderId: string;
  config: RouterConfig;
}): RouteClassifier {
  const { embed, embedderId, config } = options;
  const exemplarPairs = config.routes.flatMap((route) =>
    (route.exemplars ?? []).map((text) => ({ route, text })),
  );

  let index: Promise<ExemplarIndex> | null = null;
  const buildIndex = async (): Promise<ExemplarIndex> => {
    const digest = await sha256Hex(
      `${embedderId}::${exemplarPairs.map((p) => `${p.route.name}|${p.text}`).join('\n')}`,
    );
    const vectors = await embed(exemplarPairs.map((p) => p.text));
    return {
      digest,
      vectors: exemplarPairs.map((pair, i) => ({
        route: pair.route,
        vector: vectors[i] ?? [],
      })),
    };
  };

  return async ({ text }) => {
    if (exemplarPairs.length === 0) return null;
    index ??= buildIndex();
    const built = await index;
    const [queryVector] = await embed([text]);
    if (!queryVector) return null;

    let best: { route: Route; score: number } | null = null;
    for (const entry of built.vectors) {
      const score = cosine(queryVector, entry.vector);
      if (!best || score > best.score) {
        best = { route: entry.route, score };
      }
    }
    if (!best || best.score < config.minConfidence.embedding) return null;
    return {
      route: best.route,
      strategy: 'embedding',
      confidence: best.score,
    } satisfies RouteDecision;
  };
}
