import { type AgentMiddleware, createMiddleware } from 'langchain';
import {
  humanizeToolLabel,
  workStatusProducer,
  type WorkStatusProducer,
} from '../../matrix/work-status-producer.js';
import type { RunConfigContext } from '../../runtime-context/build-runtime.js';

/** Beat posted while the model generates, between tool calls. */
const THINKING_LABEL = 'Thinking…';

export interface WorkStatusMiddlewareOptions {
  /**
   * Status-card sink — only `step` is used. Defaults to the process-wide
   * producer the Matrix bridge drives; tests inject a stub.
   */
  producer?: Pick<WorkStatusProducer, 'step'>;
}

/**
 * Read the turn's request id off the LangGraph runtime channel. The channel is
 * typed `unknown` in a middleware that declares no context schema, so narrow
 * it at runtime; the value read is `RunConfigContext.session.requestId`, the
 * same id the Matrix bridge registers the turn under.
 */
function readRequestId(
  context: unknown,
): RunConfigContext['session']['requestId'] | undefined {
  if (typeof context !== 'object' || context === null) return undefined;
  if (!('session' in context)) return undefined;
  const session: unknown = context.session;
  if (typeof session !== 'object' || session === null) return undefined;
  if (!('requestId' in session)) return undefined;
  const requestId: unknown = session.requestId;
  return typeof requestId === 'string' && requestId.length > 0
    ? requestId
    : undefined;
}

/**
 * Drives the per-turn `work_status` liveness card from inside the graph: one
 * beat before every model call and one before every tool call, so the card
 * keeps moving for the whole turn instead of freezing on the last tool name.
 *
 * Sits at the single seam every call passes through, which is what makes it
 * cover meta-tools, sub-agent tools and non-plugin tools alike.
 *
 * Pure side effect: it returns the handler's result verbatim and never emits a
 * state channel — returning `{ messages: … }` from a middleware clobbers the
 * built-in `addMessages` reducer and breaks checkpointer thread continuity.
 * Emissions for turns the Matrix bridge never registered (HTTP/WS) are no-ops
 * in the producer, so this is inert outside Matrix.
 */
export const createWorkStatusMiddleware = (
  options: WorkStatusMiddlewareOptions = {},
): AgentMiddleware => {
  const producer = options.producer ?? workStatusProducer;

  return createMiddleware({
    name: 'WorkStatusMiddleware',
    wrapModelCall: (request, handler) => {
      const requestId = readRequestId(request.runtime?.context);
      if (requestId) producer.step(requestId, THINKING_LABEL);
      return handler(request);
    },
    wrapToolCall: (toolCallRequest, handler) => {
      const requestId = readRequestId(toolCallRequest.runtime?.context);
      if (requestId) {
        producer.step(
          requestId,
          humanizeToolLabel(toolCallRequest.toolCall.name),
        );
      }
      return handler(toolCallRequest);
    },
  });
};
