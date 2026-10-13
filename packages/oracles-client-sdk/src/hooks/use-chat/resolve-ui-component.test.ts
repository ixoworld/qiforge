import { describe, expect, it } from 'vitest';
import {
  resolveUIComponent,
  type UIComponents,
} from './resolve-ui-component.js';
import transformToMessagesMap from './transform-to-messages-map.js';

const ToolCall: UIComponents['ToolCall'] = () => null;
const ErrorView: UIComponents['Error'] = () => null;
const Weather = () => null;
const components: UIComponents = { ToolCall, Error: ErrorView, Weather };

describe('resolveUIComponent', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
    'a component named %s falls back to ToolCall instead of resolving an object prototype member',
    (name) => {
      const element = resolveUIComponent(components, {
        name,
        props: { id: 'c1', args: {} },
      });
      expect(element?.type).toBe(ToolCall);
    },
  );

  it('resolves a registered component by its own name', () => {
    const element = resolveUIComponent(components, {
      name: 'Weather',
      props: { id: 'c1', args: { city: 'Cape Town' } },
    });
    expect(element?.type).toBe(Weather);
  });
});

describe('transformToMessagesMap', () => {
  it('files a tool named after an Object prototype member under the ToolCall component', () => {
    const map = transformToMessagesMap({
      uiComponents: components,
      messages: [
        {
          id: 'm1',
          type: 'ai',
          content: '',
          toolCalls: [
            { id: 't1', name: 'constructor', args: {}, status: 'done' },
            { id: 't2', name: 'Weather', args: {}, status: 'done' },
          ],
        },
      ],
    });
    const content = map.m1!.content;
    expect(Array.isArray(content)).toBe(true);
    expect(
      Array.isArray(content) &&
        content.map((part) => (typeof part === 'string' ? part : part.name)),
    ).toEqual(['ToolCall', 'Weather']);
  });
});
