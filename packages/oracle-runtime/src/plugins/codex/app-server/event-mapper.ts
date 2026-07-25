import type { RuntimeContext } from '../../../plugin-api/types.js';
import { CODEX_PROVIDER_ID } from '../domain/provider.js';
import {
  CODEX_NOTIFICATIONS,
  deltaParamsSchema,
  itemParamsSchema,
  turnCompletedParamsSchema,
  turnStartedParamsSchema,
} from './protocol.js';

/**
 * QiForge's normalized view of an App Server notification. Every field the
 * protocol carries that a caller can act on is preserved — item identity, item
 * type, turn status and failure reason all survive the mapping.
 */
export type CodexRuntimeEvent =
  | { readonly type: 'turn.started'; readonly turnId: string }
  | {
      readonly type: 'turn.completed';
      readonly turnId: string;
      readonly status: 'completed' | 'interrupted' | 'failed';
      readonly error?: string;
    }
  | {
      readonly type: 'item.started';
      readonly itemId: string;
      readonly itemType: string;
      readonly command?: string;
    }
  | {
      readonly type: 'item.completed';
      readonly itemId: string;
      readonly itemType: string;
      readonly text?: string;
    }
  | {
      readonly type: 'message.delta';
      readonly itemId?: string;
      readonly delta: string;
    }
  | {
      readonly type: 'reasoning.delta';
      readonly itemId?: string;
      readonly delta: string;
    };

/**
 * Translate one App Server notification. Returns null for notifications the
 * harness does not model, so unknown methods are ignored rather than throwing
 * on a protocol addition.
 */
export function mapNotification(
  method: string,
  params: unknown,
): CodexRuntimeEvent | null {
  switch (method) {
    case CODEX_NOTIFICATIONS.turnStarted: {
      const parsed = turnStartedParamsSchema.safeParse(params);
      return parsed.success
        ? { type: 'turn.started', turnId: parsed.data.turn.id }
        : null;
    }
    case CODEX_NOTIFICATIONS.turnCompleted: {
      const parsed = turnCompletedParamsSchema.safeParse(params);
      if (!parsed.success) return null;
      const { turn } = parsed.data;
      return {
        type: 'turn.completed',
        turnId: turn.id,
        status: turn.status ?? 'completed',
        ...(turn.error?.message ? { error: turn.error.message } : {}),
      };
    }
    case CODEX_NOTIFICATIONS.itemStarted: {
      const parsed = itemParamsSchema.safeParse(params);
      if (!parsed.success) return null;
      const { item } = parsed.data;
      return {
        type: 'item.started',
        itemId: item.id,
        itemType: item.type ?? 'unknown',
        ...(item.command ? { command: item.command } : {}),
      };
    }
    case CODEX_NOTIFICATIONS.itemCompleted: {
      const parsed = itemParamsSchema.safeParse(params);
      if (!parsed.success) return null;
      const { item } = parsed.data;
      return {
        type: 'item.completed',
        itemId: item.id,
        itemType: item.type ?? 'unknown',
        ...(item.text ? { text: item.text } : {}),
      };
    }
    case CODEX_NOTIFICATIONS.agentMessageDelta: {
      const parsed = deltaParamsSchema.safeParse(params);
      if (!parsed.success) return null;
      return {
        type: 'message.delta',
        ...(parsed.data.itemId ? { itemId: parsed.data.itemId } : {}),
        delta: parsed.data.delta,
      };
    }
    case CODEX_NOTIFICATIONS.reasoningDelta: {
      const parsed = deltaParamsSchema.safeParse(params);
      if (!parsed.success) return null;
      return {
        type: 'reasoning.delta',
        ...(parsed.data.itemId ? { itemId: parsed.data.itemId } : {}),
        delta: parsed.data.delta,
      };
    }
    default:
      return null;
  }
}

/** Bridge a normalized Codex event onto QiForge's typed event emitter. */
export function emitCodexEvent(
  event: CodexRuntimeEvent,
  ctx: Pick<RuntimeContext, 'emit'>,
  threadId: string,
): void {
  const base = { provider: CODEX_PROVIDER_ID, threadId };

  switch (event.type) {
    case 'reasoning.delta':
      ctx.emit.reasoning({ ...base, itemId: event.itemId, text: event.delta });
      return;
    case 'message.delta':
      ctx.emit.renderComponent({
        ...base,
        component: 'codex.message',
        itemId: event.itemId,
        delta: event.delta,
      });
      return;
    case 'item.started':
    case 'item.completed':
      ctx.emit.toolCall({
        ...base,
        name: `codex.${event.itemType}`,
        itemId: event.itemId,
        status: event.type === 'item.started' ? 'started' : 'completed',
        ...(event.type === 'item.started' && event.command
          ? { command: event.command }
          : {}),
        ...(event.type === 'item.completed' && event.text
          ? { text: event.text }
          : {}),
      });
      return;
    case 'turn.started':
    case 'turn.completed':
      ctx.emit.router({
        ...base,
        turnId: event.turnId,
        phase: event.type === 'turn.started' ? 'started' : 'completed',
        ...(event.type === 'turn.completed' ? { status: event.status } : {}),
        ...(event.type === 'turn.completed' && event.error
          ? { error: event.error }
          : {}),
      });
  }
}

/**
 * Accumulates the agent's visible text across a turn. `item/completed` for an
 * agentMessage carries the authoritative text; deltas are used only when the
 * server streams without a terminal item.
 */
export class CodexTurnTranscript {
  private deltas: string[] = [];

  private completed: string[] = [];

  record(event: CodexRuntimeEvent): void {
    if (event.type === 'message.delta') {
      this.deltas.push(event.delta);
      return;
    }
    if (
      event.type === 'item.completed' &&
      event.itemType === 'agentMessage' &&
      event.text
    ) {
      this.completed.push(event.text);
      this.deltas = [];
    }
  }

  text(): string {
    if (this.completed.length > 0) return this.completed.join('\n\n').trim();
    return this.deltas.join('').trim();
  }
}
