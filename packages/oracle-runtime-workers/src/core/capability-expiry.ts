/**
 * How long an on-demand capability stays loaded on a thread.
 *
 * A loaded plugin's tools and operating guide go out with every model call,
 * so a plugin the conversation has moved on from is paid for on every call.
 * Taking it away changes the tool list and the system prompt, which costs a
 * full cache miss on a warm thread: the request's whole prefix is read again
 * at the uncached price, far more than the plugin's tools cost at the cached
 * one. On a thread that has gone quiet long enough for the provider's cache
 * to expire the miss has already happened, so the runtime only ever unloads
 * a plugin on such a turn, and only one the last `maxIdleTurns` turns did not
 * touch. The model can load it again: the capability gate's refusal says how.
 *
 * Use is read off the thread itself: a call to one of the plugin's tools, or
 * a `load_capability` naming it. Nothing is stored, so a summary that
 * condensed a plugin's last use makes it idle, which is what it is.
 */
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { LOAD_CAPABILITY_TOOL_NAME } from './meta-tools';
import { turnOpenings } from './middlewares/turn-boundary';

const loadArgs = z.object({ names: z.array(z.string()) });

/** The plugins one model response touched. */
function pluginsTouched(
  message: AIMessage,
  pluginOf: (toolName: string) => string | undefined,
): string[] {
  return (message.tool_calls ?? []).flatMap((call) => {
    if (call.name === LOAD_CAPABILITY_TOOL_NAME) {
      const args = loadArgs.safeParse(call.args);
      return args.success ? args.data.names : [];
    }
    const plugin = pluginOf(call.name);
    return plugin ? [plugin] : [];
  });
}

/**
 * Which of the `loaded` plugins no turn among the last `maxIdleTurns` of the
 * thread touched. `messages` are the finished turns, the current one not yet
 * among them; a thread with fewer turns than that unloads nothing.
 */
export function idlePlugins(input: {
  messages: readonly BaseMessage[];
  loaded: readonly string[];
  pluginOf: (toolName: string) => string | undefined;
  maxIdleTurns: number;
}): string[] {
  const { messages, loaded, pluginOf, maxIdleTurns } = input;
  if (maxIdleTurns <= 0) return [];
  const openings = turnOpenings(messages);
  const recent = openings[openings.length - maxIdleTurns];
  if (recent === undefined) return [];
  const touched = new Set<string>();
  for (const message of messages.slice(recent))
    if (AIMessage.isInstance(message))
      for (const plugin of pluginsTouched(message, pluginOf))
        touched.add(plugin);
  return loaded.filter((plugin) => !touched.has(plugin));
}
