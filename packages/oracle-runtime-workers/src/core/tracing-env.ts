import process from 'node:process';

/**
 * The `process.env` names that switch on LangChain's own tracer when one is
 * `"true"`: `@langchain/core`'s `isTracingEnabled`, read each time a run's
 * callbacks are configured, and langsmith's `isEnvTracingEnabled` (the
 * `LANGSMITH_` / `LANGCHAIN_` forms of `TRACING_V2` and `TRACING`).
 */
export const LANGCHAIN_TRACING_SWITCHES = [
  'LANGSMITH_TRACING_V2',
  'LANGCHAIN_TRACING_V2',
  'LANGSMITH_TRACING',
  'LANGCHAIN_TRACING',
] as const;

/**
 * Remove {@link LANGCHAIN_TRACING_SWITCHES} from `process.env`. With
 * `nodejs_compat` (compatibility date 2025-04-01 or later) workerd fills
 * `process.env` from the Worker's vars and secrets, so an operator's
 * `LANGSMITH_TRACING=true` would make core attach its default tracer (a
 * client from `process.env`, no redaction, no DID allowlist; with no API key
 * it still posts, unauthenticated) to every run that does not carry ours: a
 * restricted turn, and sub-agent, safety, vision, title, summarizer and
 * Decision calls. The runtime's own tracing reads the Worker `env` binding,
 * which this leaves untouched. `process.env` is per isolate and a delete
 * persists for the isolate's life.
 */
export function removeLangChainTracingSwitches(): void {
  for (const name of LANGCHAIN_TRACING_SWITCHES) delete process.env[name];
}
