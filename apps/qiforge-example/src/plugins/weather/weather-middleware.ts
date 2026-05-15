import { type AgentMiddleware, type PluginContext } from '@ixo/oracle-runtime';
import { createMiddleware } from 'langchain';

/**
 * Tiny observation middleware — logs a line before and after every model
 * call, with elapsed time. Nothing weather-specific; this hook demonstrates
 * that a plugin can attach middleware around the LLM loop.
 *
 * The timer lives on a closure-scoped variable per agent build. Concurrent
 * model calls on the same middleware instance would interleave timings —
 * acceptable for a demo, but a real plugin needing accurate per-call timing
 * would push start times onto a stack or use a per-call id from the runtime.
 */
export function buildWeatherMiddleware(ctx: PluginContext): AgentMiddleware {
  let startedAt = 0;
  return createMiddleware({
    name: 'WeatherLoggingMiddleware',
    beforeModel: async () => {
      startedAt = Date.now();
      ctx.logger.log('model call started');
    },
    afterModel: async () => {
      const elapsed = startedAt > 0 ? Date.now() - startedAt : -1;
      ctx.logger.log(`model call complete (${elapsed}ms)`);
    },
  });
}
