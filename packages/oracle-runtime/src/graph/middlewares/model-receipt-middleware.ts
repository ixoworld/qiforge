import { type AgentMiddleware, createMiddleware } from 'langchain';
import type { AuditSink } from '../../kernel/audit.js';

export interface ModelReceiptMiddlewareOptions {
  audit?: AuditSink;
  /** Role label of the loop this middleware observes ('main' or a sub-agent role). */
  role: string;
  /** Best-effort expected target from the policy at build time. */
  expected?: { provider: string; model: string };
  sessionId: string;
  requestId: string;
}

function extractActualModel(message: unknown): string | undefined {
  if (
    !message ||
    typeof message !== 'object' ||
    !('response_metadata' in message)
  ) {
    return undefined;
  }
  const meta = (message as { response_metadata?: unknown }).response_metadata;
  if (!meta || typeof meta !== 'object') return undefined;
  const model = (meta as Record<string, unknown>).model;
  return typeof model === 'string' ? model : undefined;
}

/**
 * Transparent model authority: every completed model call appends a
 * `model.receipt` audit record — requested role, expected policy target,
 * the model that ACTUALLY answered (from response metadata), and whether
 * that differs from the expectation (fallback or provider-side rerouting).
 * The operator's evidence that the model policy is the model reality.
 */
export const createModelReceiptMiddleware = (
  options: ModelReceiptMiddlewareOptions,
): AgentMiddleware => {
  const { audit, role, expected, sessionId, requestId } = options;

  return createMiddleware({
    name: 'ModelReceiptMiddleware',
    afterModel: (state) => {
      if (!audit) return undefined;
      const actualModel = extractActualModel(state.messages.at(-1));
      if (!actualModel) return undefined;
      const expectedModel = expected?.model;
      void Promise.resolve(
        audit.append({
          kind: 'model.receipt',
          at: new Date().toISOString(),
          sessionId,
          requestId,
          detail: {
            role,
            ...(expected ? { expectedProvider: expected.provider } : {}),
            ...(expectedModel ? { expectedModel } : {}),
            actualModel,
            ...(expectedModel && actualModel !== expectedModel
              ? { divergedFromExpected: true }
              : {}),
          },
        }),
      ).catch(() => undefined);
      return undefined;
    },
  });
};
