import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  planCapabilityContext,
  renderGuideNote,
  usageCarriedBy,
  USAGE_CARRIED_KWARG,
} from './operating-guides';

const guides = [
  { pluginName: 'always', guide: 'A' },
  { pluginName: 'flows', guide: 'F' },
  { pluginName: 'sandbox', guide: 'S' },
];

function plan(input: {
  loaded: string[];
  priorLoaded?: string[];
  cold: boolean;
  promptGuides?: string[];
  capabilityUsage?: string[];
}) {
  const result = planCapabilityContext({
    guides,
    loaded: new Set(input.loaded),
    priorLoaded: new Set(input.priorLoaded ?? input.loaded),
    usable: (pluginName) => pluginName !== 'forbidden',
    alwaysVisible: (pluginName) => pluginName === 'always',
    cache: {
      cold: input.cold,
      ...(input.promptGuides ? { promptGuides: input.promptGuides } : {}),
      ...(input.capabilityUsage
        ? { capabilityUsage: input.capabilityUsage }
        : {}),
    },
  });
  return { ...result, inPrompt: result.inPrompt.map((g) => g.pluginName) };
}

describe('planCapabilityContext', () => {
  it('puts every loaded guide in the prompt on a cold turn and records the set', () => {
    const { inPrompt, onMessage, promptGuides } = plan({
      loaded: ['flows'],
      cold: true,
      capabilityUsage: ['flows'],
    });
    expect(inPrompt).toEqual(['always', 'flows']);
    expect(onMessage).toEqual([]);
    expect(promptGuides).toEqual(['flows']);
  });

  it('holds the recorded set on a warm turn and writes nothing', () => {
    expect(
      plan({
        loaded: ['flows'],
        cold: false,
        promptGuides: ['flows'],
        capabilityUsage: ['flows'],
      }),
    ).toEqual({ inPrompt: ['always', 'flows'], onMessage: [] });
  });

  it('sends a preload of a warm turn to the message, the prompt untouched', () => {
    const { inPrompt, onMessage, promptGuides, capabilityUsage } = plan({
      loaded: ['sandbox'],
      priorLoaded: [],
      cold: false,
      promptGuides: [],
      capabilityUsage: [],
    });
    expect(inPrompt).toEqual(['always']);
    expect(onMessage).toEqual(['sandbox']);
    expect(promptGuides).toBeUndefined();
    expect(capabilityUsage).toEqual(['sandbox']);
  });

  it('sends the usage of a preload of a cold turn to the message too, with the guide in the prompt', () => {
    const { inPrompt, onMessage } = plan({
      loaded: ['sandbox'],
      priorLoaded: [],
      cold: true,
      capabilityUsage: [],
    });
    expect(inPrompt).toEqual(['always', 'sandbox']);
    expect(onMessage).toEqual(['sandbox']);
  });

  it('covers a plugin with no guide just the same', () => {
    expect(
      plan({
        loaded: ['vfs'],
        priorLoaded: [],
        cold: false,
        promptGuides: [],
        capabilityUsage: [],
      }).onMessage,
    ).toEqual(['vfs']);
  });

  it('sends usage again once the thread no longer carries it, and nothing a delegation cannot use', () => {
    const { onMessage, capabilityUsage } = plan({
      loaded: ['flows', 'forbidden'],
      cold: false,
      promptGuides: ['flows'],
      capabilityUsage: [],
    });
    expect(onMessage).toEqual(['flows']);
    expect(capabilityUsage).toEqual(['flows']);
  });

  it('forgets the usage of a plugin a cold turn unloaded', () => {
    const { capabilityUsage, onMessage } = plan({
      loaded: ['sandbox'],
      priorLoaded: ['flows', 'sandbox'],
      cold: true,
      capabilityUsage: ['flows', 'sandbox'],
    });
    expect(onMessage).toEqual([]);
    expect(capabilityUsage).toEqual(['sandbox']);
  });

  it('reads a thread from before the records as carrying what it had loaded, and records that', () => {
    const { inPrompt, onMessage, promptGuides, capabilityUsage } = plan({
      loaded: ['flows', 'sandbox'],
      priorLoaded: ['flows'],
      cold: false,
    });
    expect(inPrompt).toEqual(['always', 'flows']);
    expect(onMessage).toEqual(['sandbox']);
    expect(promptGuides).toEqual(['flows']);
    expect(capabilityUsage).toEqual(['flows', 'sandbox']);
  });

  it('counts every turn as cold without cache state', () => {
    const { inPrompt, promptGuides } = planCapabilityContext({
      guides,
      loaded: new Set(['sandbox']),
      priorLoaded: new Set(),
      usable: () => true,
      alwaysVisible: (pluginName) => pluginName === 'always',
    });
    expect(inPrompt.map((g) => g.pluginName)).toEqual(['always', 'sandbox']);
    expect(promptGuides).toEqual(['sandbox']);
  });
});

describe('usageCarriedBy', () => {
  it('reads the mark, and nothing from a message without a usable one', () => {
    expect(
      usageCarriedBy(
        new HumanMessage({
          content: 'x',
          additional_kwargs: { [USAGE_CARRIED_KWARG]: ['flows', 7] },
        }),
      ),
    ).toEqual(['flows']);
    expect(usageCarriedBy(new HumanMessage('x'))).toEqual([]);
  });
});

describe('renderGuideNote', () => {
  it('says it is not from the user and carries every load', () => {
    const note = renderGuideNote([{ name: 'one' }, { name: 'two' }]);
    expect(note).toContain('not the user');
    expect(note.endsWith('[{"name":"one"},{"name":"two"}]')).toBe(true);
  });
});
