/**
 * Drives the per-turn `work_status` liveness card from inside the graph —
 * the port of the Node runtime's `WorkStatusMiddleware`: one `Step n ·
 * Thinking…` per model call and one `Step n · <Tool name>…` per tool call,
 * read off the run context's `session.requestId`. A pure side effect: it
 * returns the handler's result verbatim and never throws on its own.
 *
 * Turns that were not registered with the producer (HTTP turns, task runs)
 * are no-ops, so the middleware is safe to install unconditionally.
 */
import { type AgentMiddleware, createMiddleware } from 'langchain';
import {
  humanizeToolLabel,
  type WorkStatusProducer,
} from '../../matrix/work-status';

const THINKING_LABEL = 'Thinking…';

export interface WorkStatusMiddlewareOptions {
  producer: Pick<WorkStatusProducer, 'step'>;
}

function readRequestId(context: unknown): string | undefined {
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

export function createWorkStatusMiddleware(
  options: WorkStatusMiddlewareOptions,
): AgentMiddleware {
  const { producer } = options;
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
}
