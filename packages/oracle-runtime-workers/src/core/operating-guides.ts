/**
 * Where what the model needs to use a loaded plugin reaches it: the plugin's
 * usage (`summary`, `whenToUse`, `whenNotToUse`, `examples`, the tool names)
 * and its operating guide.
 *
 * A guide in the system prompt is the cheapest place for it: cached like the
 * rest of the prefix, it survives summaries and trimming. But any change to
 * the system prompt costs a full cache miss on the next call, so the guides
 * in the prompt only change on a cold turn, when that miss has already
 * happened (`CONTEXT_CACHE_COLD_MS`). The set the prompt carries is recorded
 * on the thread (the graph's `promptGuides` channel) and held until then.
 *
 * Usage, and a guide outside the prompt, go at the tail of the messages, which
 * keeps the cache: in the result of the load that brought the plugin
 * (`load_capability`, the capability gate), or as a note on the turn's message
 * when nothing called a load (a router preload, the editor context) or a
 * summary has condensed that result away. The thread records which plugins it
 * still carries in the graph's `capabilityUsage` channel, so a turn needs no
 * read of the messages to know, and the messages that carry them say so in
 * `USAGE_CARRIED_KWARG`: the context guard keeps them while the plugin is
 * loaded, and a summary keeps the record of the ones it did not condense.
 */
import type { BaseMessage } from '@langchain/core/messages';
import { OPERATING_GUIDES_HEADING } from './prompt-composer';

/** `additional_kwargs` key listing the plugins whose usage a message carries. */
export const USAGE_CARRIED_KWARG = 'capability_usage';

/** `additional_kwargs` key holding the exact note a user message was sent with. */
export const TURN_GUIDE_NOTE_KWARG = 'turn_guide_note';

/** The plugins whose usage `message` carries. */
export function usageCarriedBy(message: BaseMessage): string[] {
  const carried: unknown = message.additional_kwargs?.[USAGE_CARRIED_KWARG];
  return Array.isArray(carried)
    ? carried.filter((name) => typeof name === 'string')
    : [];
}

/**
 * The note a turn's message carries for plugins that have no load result in
 * the thread: what `load_capability` would have returned for them.
 */
export function renderGuideNote(loads: readonly unknown[]): string {
  return `[From the runtime, not the user: these capabilities are loaded and in your tool list.]\n\n${OPERATING_GUIDES_HEADING}\n\n${JSON.stringify(loads)}`;
}

/** What the thread records about its prompt, and whether the prompt may change. */
export interface PromptCacheState {
  /** The provider's cache has expired (or never held this thread). */
  cold: boolean;
  /**
   * The plugins whose guides the prompt carried on the thread's last turn.
   * Undefined on a thread from before this was recorded, whose prompt carried
   * every loaded plugin's guide.
   */
  promptGuides?: readonly string[];
  /**
   * The plugins whose usage the thread's messages carry. Undefined on a thread
   * from before this was recorded, which counts as carrying what it loaded.
   */
  capabilityUsage?: readonly string[];
}

export interface UsableGuide {
  pluginName: string;
  guide: string;
}

export interface CapabilityPlan {
  /** The guides of this turn's system prompt, in the order they were given. */
  inPrompt: UsableGuide[];
  /** Loaded plugins whose usage the thread does not carry: for the turn's message. */
  onMessage: string[];
  /** The new value of the `promptGuides` channel, when it is decided now. */
  promptGuides?: string[];
  /** The new value of the `capabilityUsage` channel, when it changes. */
  capabilityUsage?: string[];
}

function sameMembers(a: readonly string[], b: ReadonlySet<string>): boolean {
  return a.length === b.size && a.every((name) => b.has(name));
}

/**
 * Decides where each plugin's guide and usage go this turn. `always` plugins
 * have their guides in the prompt on every turn. Without a `cache` every turn
 * counts as cold.
 */
export function planCapabilityContext(input: {
  guides: readonly UsableGuide[];
  /** The plugins loaded on the thread when the turn was built. */
  loaded: ReadonlySet<string>;
  /** The same, before this turn added to it. */
  priorLoaded: ReadonlySet<string>;
  /** Whether this delegation can use the plugin at all. */
  usable: (pluginName: string) => boolean;
  alwaysVisible: (pluginName: string) => boolean;
  cache?: PromptCacheState;
}): CapabilityPlan {
  const { guides, loaded, priorLoaded, usable, alwaysVisible, cache } = input;
  const cold = !cache || cache.cold;
  const recorded = cold ? loaded : new Set(cache.promptGuides ?? priorLoaded);
  const carried = new Set(cache?.capabilityUsage ?? priorLoaded);
  const onMessage = [...loaded].filter(
    (pluginName) => usable(pluginName) && !carried.has(pluginName),
  );
  const capabilityUsage = new Set(
    [...loaded].filter(
      (pluginName) => carried.has(pluginName) || onMessage.includes(pluginName),
    ),
  );
  return {
    inPrompt: guides.filter(
      ({ pluginName }) => alwaysVisible(pluginName) || recorded.has(pluginName),
    ),
    onMessage,
    ...(cold || cache.promptGuides === undefined
      ? { promptGuides: [...recorded] }
      : {}),
    ...(cache?.capabilityUsage !== undefined &&
    sameMembers(cache.capabilityUsage, capabilityUsage)
      ? {}
      : { capabilityUsage: [...capabilityUsage] }),
  };
}
