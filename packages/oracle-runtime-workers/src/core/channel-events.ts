import type { OraclePlugin } from '../plugin-api/oracle-plugin';
import {
  MAX_CHANNEL_EVENT_TEXT,
  type ChannelEventResult,
  type OracleChannelEvent,
} from '../plugin-api/channel-events';
import type { RuntimeContext } from '../plugin-api/types';

/** What the runtime does with an event: never `pass`. */
export type ChannelEventDecision = Exclude<
  ChannelEventResult,
  { kind: 'pass' }
>;

function usable(value: string): boolean {
  return value.trim() !== '' && value.length <= MAX_CHANNEL_EVENT_TEXT;
}

/**
 * Hand an event to the plugins in order: the first answer that is not
 * `pass` decides. No plugin claims the card or link: `ignore`. A plugin that
 * throws, or answers an empty or oversized text, is logged and the event is
 * ignored: an event never fails the person's conversation.
 */
export async function routeChannelEvent(
  plugins: readonly OraclePlugin[],
  event: OracleChannelEvent,
  ctx: RuntimeContext,
  warn: (message: string) => void,
): Promise<ChannelEventDecision> {
  for (const plugin of plugins) {
    if (!plugin.handleChannelEvent) continue;
    let result: ChannelEventResult;
    try {
      result = await plugin.handleChannelEvent(event, ctx);
    } catch (error) {
      warn(
        `channel event by ${plugin.name} failed: ${error instanceof Error ? error.name : typeof error}`,
      );
      return { kind: 'ignore' };
    }
    if (result.kind === 'pass') continue;
    if (
      (result.kind === 'reply' &&
        (!usable(result.text) || !usable(result.note))) ||
      (result.kind === 'agent' && !usable(result.note))
    ) {
      warn(`channel event by ${plugin.name}: invalid answer`);
      return { kind: 'ignore' };
    }
    return result;
  }
  return { kind: 'ignore' };
}
