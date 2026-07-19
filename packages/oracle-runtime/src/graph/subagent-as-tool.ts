import type { BaseCheckpointSaver } from '@langchain/langgraph';
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import {
  createAgent,
  type AgentMiddleware,
  type StructuredTool,
} from 'langchain';
import { emojify } from '../utils/emoji.js';
import { z } from 'zod';
import { sha256Hex, type AuditRecord } from '../kernel/audit.js';
import type { Logger } from '../plugin-api/types.js';

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Spec for an agent that runs as a one-shot sub-agent (called by a parent
 * agent through `createSubagentAsTool`).
 *
 * `tools` is optional so plugin-defined sub-agents that contribute only
 * routing logic (no tools) can still be wrapped.
 *
 * `passthroughTools` are runtime-injected tools (e.g. memory CRUD) that
 * every sub-agent should be able to call regardless of which plugin owns the
 * sub-agent. They are concatenated after `tools` when building the inner
 * agent so the sub-agent's own tools take precedence in collisions.
 */
export interface AgentSpec {
  name: string;
  description: string;
  tools?: StructuredTool[];
  passthroughTools?: StructuredTool[];
  systemPrompt: string;
  model?: Parameters<typeof createAgent>[0]['model'];
  middleware?: AgentMiddleware[];
  userDid: string;
  sessionId: string;
  /** Appended to thread_id to scope the agent's conversation (e.g. a room ID). */
  threadSuffix?: string;
  /**
   * Checkpointer (or a factory resolved per-invocation given the userDid).
   * Sub-agents are EPHEMERAL BY DEFAULT — the default adaptor wires no
   * checkpointer, so each invocation starts from only its task string. Supply
   * one here (plugin-side or via a custom `toAgentSpec`) to opt a sub-agent
   * into persistence; thread ids are then namespaced
   * `${sessionId}_${name}${threadSuffix ?? ''}`.
   */
  checkpointer?:
    | BaseCheckpointSaver
    | ((userDid: string) => Promise<BaseCheckpointSaver>);
  /** Optional logger; defaults to a no-op. */
  logger?: Logger;
  /**
   * Refusal policy. `'surface'` (default) returns a refusal verbatim to the
   * parent agent. `'retry-once'` re-invokes once with an honest
   * automated-retry preamble — permitted only for sub-agents that declare
   * `readOnly: true`; the registry rejects the combination otherwise.
   */
  onRefusal?: 'surface' | 'retry-once';
  /**
   * Declares that every tool on this sub-agent is non-mutating. Gate for
   * `onRefusal: 'retry-once'`.
   */
  readOnly?: boolean;
  /** Inner-loop recursion limit. Default `DEFAULT_SUBAGENT_RECURSION_LIMIT`. */
  recursionLimit?: number;
  /**
   * Audit hook — receives authority-relevant records (today: refusal
   * retries). Wired by the runtime to the ambient `AuditSink`; the record
   * carries digests, never raw task text.
   */
  emitAudit?: (record: AuditRecord) => void;
  /**
   * Tool names whose AIMessage(tool_calls) + ToolMessage results should be
   * forwarded into the parent graph's messages via Command. Surfaced on the
   * spec so adaptors (e.g. plugin → spec conversion) can resolve a plugin's
   * declared `forwardTools` once and let the wrapper pick it up downstream.
   */
  forwardTools?: string[];
}

/**
 * Options for createSubagentAsTool — controlled by the oracle, not the agent.
 */
export interface SubagentToolOptions {
  /**
   * Tool names whose AIMessage(tool_calls) + ToolMessage results should be
   * forwarded into the parent graph's messages via Command.
   * The SSE stream will pick them up as regular tool call events.
   */
  forwardTools?: string[];
  /** Called after subagent completes with the full message history. Fire-and-forget. */
  onComplete?: (messages: BaseMessage[], task: string) => void;
}

const taskSchema = z.object({
  task: z
    .string()
    .describe(
      'A detailed, self-contained instruction for the sub-agent. ' +
        'The sub-agent has NO access to conversation history, user context, or prior messages — ' +
        'this string is ALL it receives. Include: (1) explicit objective, (2) all relevant context ' +
        '(names, IDs, URLs, dates, values), (3) expected output format, (4) constraints/scope.',
    ),
});

const REFUSAL_PATTERNS = [
  "i'm sorry, but i can't",
  'i cannot comply',
  "i can't comply",
  "i'm unable to",
  'i cannot provide',
  "i can't provide",
  "i'm not able to",
];

function isRefusal(text: string): boolean {
  const lower = text.toLowerCase();
  return REFUSAL_PATTERNS.some((p) => lower.includes(p));
}

/** Default recursion limit for a sub-agent's inner loop. The outer graph's
 * limit does not reach inner `createAgent` runs, so an explicit bound is set
 * on every invocation. */
export const DEFAULT_SUBAGENT_RECURSION_LIMIT = 50;

/**
 * Honest automated-retry preamble used by `onRefusal: 'retry-once'`. It
 * claims no authority and fabricates no approval — it asks the sub-agent to
 * either proceed within its own instructions or name the blocking reason.
 */
const REFUSAL_RETRY_PREAMBLE =
  'Your previous response declined this task. This is an automated retry: ' +
  'if the task is within your instructions and tools, complete it now; ' +
  'otherwise state the specific reason you cannot.\n\n';

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function lastMessageContent(messages: BaseMessage[]): string {
  const last = messages.at(-1);
  if (!last?.content) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    const textPart = last.content.find(
      (block: { type?: string; text?: string }) =>
        block.type === 'text' && block.text,
    );
    return (textPart as { text?: string } | undefined)?.text ?? '';
  }
  return JSON.stringify(last.content);
}

/**
 * Filter subagent messages to only those whose tool name is in forwardTools.
 * Returns AIMessages (with tool_calls filtered) and their matching ToolMessages.
 *
 * Rewrites each forwarded tool_call id with `idPrefix` so ids are unique
 * across sub-agent invocations. Without this, each sub-agent run produces
 * LangChain-generated ids like `functions.create_data_table:0` starting at
 * 0, and two invocations in one chat collide — the frontend uses these
 * ids as React keys and picks the wrong artifact.
 *
 * Exported so ad-hoc sub-agent runners (e.g. the editor's standalone tool,
 * which spins up its own inner agent instead of going through
 * `createSubagentAsTool`) forward with identical semantics.
 */
export function filterForwardedMessages(
  messages: BaseMessage[],
  forwardTools: Set<string>,
  idPrefix: string,
): BaseMessage[] {
  const oldToNewId = new Map<string, string>();

  return messages.reduce<BaseMessage[]>((acc, msg) => {
    if (msg.type === 'ai') {
      const aiMsg = msg as AIMessage;
      const calls = (aiMsg.tool_calls ?? []).filter((tc) =>
        forwardTools.has(tc.name),
      );
      if (calls.length === 0) return acc;
      const rewritten = calls.map((tc) => {
        if (!tc.id) return tc;
        const newId = `${idPrefix}_${tc.id}`;
        oldToNewId.set(tc.id, newId);
        return { ...tc, id: newId };
      });
      acc.push(new AIMessage({ content: '', tool_calls: rewritten }));
    }

    if (msg.type === 'tool') {
      const toolMsg = msg as ToolMessage;
      const newId = oldToNewId.get(toolMsg.tool_call_id);
      if (newId === undefined) return acc;
      acc.push(
        new ToolMessage({
          content: toolMsg.content,
          tool_call_id: newId,
          ...(toolMsg.name ? { name: toolMsg.name } : {}),
        }),
      );
    }

    return acc;
  }, []);
}

async function resolveCheckpointer(
  spec: AgentSpec,
): Promise<BaseCheckpointSaver | undefined> {
  if (!spec.checkpointer) return undefined;
  if (typeof spec.checkpointer === 'function') {
    return spec.checkpointer(spec.userDid);
  }
  return spec.checkpointer;
}

/**
 * Wraps an AgentSpec as a LangChain tool. When the parent agent calls this
 * tool with a task, an ephemeral agent runs (model + tools + systemPrompt)
 * and the final reply text is returned.
 *
 * @param options.forwardTools — tool names whose calls should be pushed into
 *   the parent graph's messages via Command (decided by the oracle).
 */
/**
 * Compute the tool name the agent will see for a sub-agent given its
 * authored name. Single source of truth — used by `createSubagentAsTool` to
 * actually create the tool AND by the manifest validator to know what the
 * agent will see. Keeping these in lockstep prevents silent drift.
 *
 * Example: `"Portal Agent"` → `"call_portal_agent"`.
 */
export function computeSubAgentToolName(subAgentName: string): string {
  const base = subAgentName.toLowerCase().replace(/\s+/g, '_');
  return base.endsWith('_agent') ? `call_${base}` : `call_${base}_agent`;
}

export function createSubagentAsTool(
  spec: AgentSpec,
  options?: SubagentToolOptions,
): StructuredTool {
  const toolName = computeSubAgentToolName(spec.name);
  const forwardSet = new Set(options?.forwardTools ?? []);
  const logger = spec.logger ?? NOOP_LOGGER;

  const invoke = async (
    agent: ReturnType<typeof createAgent>,
    task: string,
    parentConfigurable: Record<string, unknown> | undefined,
    parentContext: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
  ) => {
    // Merge parent's configurable so fields like `requestId` and `configs`
    // propagate into the sub-agent's tool invocations. Override `thread_id`
    // (for checkpoint isolation) and set an explicit `sessionId` (distinct
    // from thread_id) so WS-routing code can reach the user's real session.
    // Forward `context` so `wrapPluginTool`-wrapped inner tools can build a
    // RuntimeContext (user + session) when fired by the sub-agent. Forward
    // the parent's `signal` so a user abort cancels the inner loop too, and
    // bound the inner loop explicitly — the outer graph's recursionLimit
    // does not apply inside a nested `createAgent` run.
    const result = await agent.invoke(
      { messages: [new HumanMessage(task)] },
      {
        configurable: {
          ...(parentConfigurable ?? {}),
          thread_id: `${spec.sessionId}_${spec.name}${spec.threadSuffix ?? ''}`,
          sessionId: spec.sessionId,
        },
        ...(parentContext ? { context: parentContext } : {}),
        runName: spec.name,
        ...(signal ? { signal } : {}),
        recursionLimit: spec.recursionLimit ?? DEFAULT_SUBAGENT_RECURSION_LIMIT,
      },
    );
    return result.messages as BaseMessage[];
  };

  const shouldRetryRefusal = (messages: BaseMessage[]) =>
    spec.onRefusal === 'retry-once' &&
    spec.readOnly === true &&
    isRefusal(lastMessageContent(messages)) &&
    spec.tools !== undefined &&
    spec.tools.length > 0;

  const auditRefusalRetry = async (task: string): Promise<void> => {
    logger.warn(
      `${spec.name} declined the task; retrying once (onRefusal=retry-once, readOnly sub-agent)`,
    );
    if (!spec.emitAudit) return;
    const taskDigest = await sha256Hex(task);
    spec.emitAudit({
      kind: 'subagent.refusal-retry',
      at: new Date().toISOString(),
      sessionId: spec.sessionId,
      detail: { subAgent: spec.name, taskDigest },
    });
  };

  const buildResult = (
    messages: BaseMessage[],
    toolCallId: string,
  ): string | Command => {
    const text = emojify(lastMessageContent(messages).toString());
    if (forwardSet.size === 0) return text;

    const idPrefix =
      toolCallId || `run_${globalThis.crypto.randomUUID().slice(0, 8)}`;
    const forwarded = filterForwardedMessages(messages, forwardSet, idPrefix);
    if (forwarded.length === 0) return text;

    return new Command({
      update: {
        messages: [
          ...forwarded,
          new ToolMessage({ content: text, tool_call_id: toolCallId }),
        ],
      },
    });
  };

  return tool(
    async ({ task }: z.infer<typeof taskSchema>, config) => {
      const signal = config.signal;
      try {
        if (!spec.model) {
          return `Error: ${spec.name} has no model configured.`;
        }

        const checkpointer = await resolveCheckpointer(spec);

        const innerTools: StructuredTool[] = [
          ...(spec.tools ?? []),
          ...(spec.passthroughTools ?? []),
        ];

        const agent = createAgent({
          model: spec.model,
          tools: innerTools,
          systemPrompt: spec.systemPrompt,
          middleware: spec.middleware ?? [],
          checkpointer,
        });

        const parentConfigurable = config.configurable as
          | Record<string, unknown>
          | undefined;
        const parentContext = (
          config as unknown as { context?: Record<string, unknown> }
        ).context;

        let messages = await invoke(
          agent,
          task,
          parentConfigurable,
          parentContext,
          signal,
        );

        // Abort is terminal: once the parent run is cancelled, nothing may
        // be written on the user's behalf — no retry, no onComplete, no
        // tool result. Rethrow so the graph tears the run down.
        if (signal?.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error(`${spec.name} run aborted`);
        }

        if (shouldRetryRefusal(messages)) {
          await auditRefusalRetry(task);
          messages = await invoke(
            agent,
            `${REFUSAL_RETRY_PREAMBLE}${task}`,
            parentConfigurable,
            parentContext,
            signal,
          );
          if (signal?.aborted) {
            throw signal.reason instanceof Error
              ? signal.reason
              : new Error(`${spec.name} run aborted`);
          }
        }

        if (options?.onComplete) {
          // Fire-and-forget — don't await, don't block the tool reply.
          void Promise.resolve().then(() =>
            options.onComplete!(messages, task),
          );
        }

        return buildResult(messages, config.toolCall?.id ?? '');
      } catch (err) {
        // Cancellation propagates as a failure, never as a tool-result
        // string a model could read on a run that is already being torn
        // down.
        if (signal?.aborted || isAbortError(err)) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        return `Error running ${spec.name}: ${message}`;
      }
    },
    {
      name: toolName,
      description: spec.description,
      schema: taskSchema,
    },
  );
}
