import {
  getContextVariable,
  setContextVariable,
} from '@langchain/core/context';
import { isBaseMessage, type BaseMessage } from '@langchain/core/messages';
import {
  getCurrentTaskInput,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';

/**
 * Cross-graph thread visibility.
 *
 * A sub-agent runs as its own LangGraph inside a parent graph's tool call, so
 * `getCurrentTaskInput()` inside the sub-agent's tools sees only the inner
 * thread — and the `RuntimeContext` handed to tool handlers deliberately
 * carries no message history (pinning it in every tool closure would hold the
 * whole thread in memory for the run). Tools that genuinely need the invoking
 * conversation — e.g. execution-trace capture — read it through here instead:
 * the sub-agent wrapper publishes the parent thread's live messages as an
 * AsyncLocalStorage context variable scoped to the nested invocation, so
 * nothing outlives the call.
 */
const PARENT_THREAD_MESSAGES = Symbol.for(
  'ixo.oracle-runtime.parentThreadMessages',
);

function asMessages(value: unknown): readonly BaseMessage[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const messages = value.filter((entry): entry is BaseMessage =>
    isBaseMessage(entry),
  );
  return messages.length === value.length ? messages : undefined;
}

/**
 * The message history of the LangGraph task currently executing, read from
 * the graph's own state (via AsyncLocalStorage, or an explicitly passed node
 * config). `undefined` outside a graph task or when the state has no
 * non-empty `messages` channel.
 */
export function currentTaskMessages(
  config?: LangGraphRunnableConfig,
): readonly BaseMessage[] | undefined {
  let input: unknown;
  try {
    input = getCurrentTaskInput(config);
  } catch {
    return undefined;
  }
  if (input === null || typeof input !== 'object') return undefined;
  return asMessages((input as { messages?: unknown }).messages);
}

/**
 * Publish the invoking thread's messages for a nested agent invocation.
 * Callers publish right before running the inner agent; the value is held
 * only by the async-context store of that invocation.
 */
export function publishParentThreadMessages(
  messages: readonly BaseMessage[],
): void {
  setContextVariable(PARENT_THREAD_MESSAGES, messages);
}

/**
 * The invoking (parent) thread's messages, when running inside a nested
 * agent whose wrapper published them. `undefined` otherwise.
 */
export function parentThreadMessages(): readonly BaseMessage[] | undefined {
  return asMessages(getContextVariable(PARENT_THREAD_MESSAGES));
}
