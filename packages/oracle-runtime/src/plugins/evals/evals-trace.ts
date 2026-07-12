import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import {
  currentTaskMessages,
  parentThreadMessages,
} from '../../graph/thread-context.js';
import type { RuntimeContext } from '../../plugin-api/types.js';
import { canonicalJsonString, cidV1RawSha256Utf8 } from './content-cid.js';

/**
 * Trace capture: serialize the current thread's tool-call history into a
 * deterministic trace document, persist it to the session's Matrix room
 * (Matrix is the claims/evidence data plane), and reference it as the
 * `claim.trace { uri, cid }` the Evals Engine requires from automated agents.
 * The CID is computed over the canonical JSON bytes of the document with the
 * engine's content-proof convention (CIDv1, raw codec, sha2-256), so an
 * auditor who fetches the Matrix event can recompute and match it.
 */

export interface TraceToolCall {
  id: string;
  name: string;
  args: unknown;
  /** Flattened ToolMessage content, when the call has a recorded result. */
  output?: string;
  status: 'ok' | 'error' | 'pending';
}

export interface AgentTraceDocument {
  schema: 'oracle.agent-trace.v1';
  sessionId: string;
  requestId: string;
  /** Total messages in the thread when the trace was captured. */
  messageCount: number;
  toolCalls: TraceToolCall[];
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) {
          const text = (block as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

/**
 * Walk the thread history and pair every `AIMessage.tool_calls` entry with
 * its `ToolMessage` result by `tool_call_id`. Calls without a recorded
 * result stay `pending` (e.g. the in-flight call that triggered this
 * capture — the evals tools themselves).
 */
export function serializeToolCallTrace(
  messages: readonly BaseMessage[],
  session: { sessionId: string; requestId: string },
): AgentTraceDocument {
  const toolCalls: TraceToolCall[] = [];
  const byId = new Map<string, TraceToolCall>();

  for (const message of messages) {
    if (AIMessage.isInstance(message) && message.tool_calls) {
      for (const call of message.tool_calls) {
        if (!call.id) continue;
        const entry: TraceToolCall = {
          id: call.id,
          name: call.name,
          args: call.args,
          status: 'pending',
        };
        toolCalls.push(entry);
        byId.set(call.id, entry);
      }
      continue;
    }
    if (message instanceof ToolMessage) {
      const entry = byId.get(message.tool_call_id);
      if (!entry) continue;
      entry.output = flattenContent(message.content);
      entry.status = message.status === 'error' ? 'error' : 'ok';
    }
  }

  return {
    schema: 'oracle.agent-trace.v1',
    sessionId: session.sessionId,
    requestId: session.requestId,
    messageCount: messages.length,
    toolCalls,
  };
}

/** Matrix event content posted to the session room. The document travels
 * verbatim under a namespaced key so auditors can extract it, canonicalize,
 * and recompute the CID. */
export const TRACE_EVENT_KEY = 'world.ixo.evals.trace';

export type TraceRef = { uri: string; cid: string };
export type TraceCaptureResult = TraceRef | { error: string };

/**
 * The thread whose execution the trace should describe. The `RuntimeContext`
 * handed to tool handlers deliberately carries an empty message history (the
 * runtime does not pin the thread into tool closures), so the live thread is
 * resolved from the graph machinery instead, most-informative first:
 *
 * 1. The parent thread published by the sub-agent wrapper — when these tools
 *    run inside `call_evals_agent`, the work being claimed happened in the
 *    conversation that invoked the sub-agent, not in the sub-agent's own
 *    short thread.
 * 2. The current graph task's own state — the thread itself when an evals
 *    tool is mounted directly on an agent's graph.
 * 3. `rtCtx.history.messages` — direct programmatic invocations that build a
 *    populated context by hand.
 */
function resolveThreadMessages(rtCtx: RuntimeContext): readonly BaseMessage[] {
  return (
    parentThreadMessages() ?? currentTaskMessages() ?? rtCtx.history.messages
  );
}

/**
 * Capture the current turn's tool-call trace: serialize, post to the
 * session's Matrix room, and return `{ uri, cid }` for `claim.trace`. The
 * URI is an MSC2312 matrix URI (`matrix:roomid/<room>/e/<event>`) pointing
 * at the posted event. Non-throwing — callers surface `{ error }` to the
 * agent.
 */
export async function captureTrace(
  rtCtx: RuntimeContext,
): Promise<TraceCaptureResult> {
  const roomId = rtCtx.session.roomId;
  if (!roomId) {
    return {
      error:
        'Trace capture requires a session Matrix room, and this invocation has none.',
    };
  }

  const messages = resolveThreadMessages(rtCtx);
  if (messages.length === 0) {
    return {
      error:
        'Trace capture found no thread history for this invocation — an empty trace would be a useless audit artifact, so none was posted.',
    };
  }

  const document = serializeToolCallTrace(messages, {
    sessionId: rtCtx.session.id,
    requestId: rtCtx.session.requestId,
  });
  const cid = cidV1RawSha256Utf8(canonicalJsonString(document));

  let eventId: string;
  try {
    eventId = await rtCtx.matrix.postToRoom(roomId, {
      msgtype: 'm.notice',
      body: `Agent execution trace ${cid} (${document.toolCalls.length} tool calls)`,
      [TRACE_EVENT_KEY]: { cid, document },
    });
  } catch (cause) {
    return {
      error: `Trace capture failed to post to the session room: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }

  return { uri: matrixEventUri(roomId, eventId), cid };
}

/** MSC2312 matrix URI for a room event: sigils stripped, segments encoded. */
export function matrixEventUri(roomId: string, eventId: string): string {
  const room = encodeURIComponent(roomId.replace(/^!/, ''));
  const event = encodeURIComponent(eventId.replace(/^\$/, ''));
  return `matrix:roomid/${room}/e/${event}`;
}
