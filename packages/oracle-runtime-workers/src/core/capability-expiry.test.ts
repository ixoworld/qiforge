import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { idlePlugins } from './capability-expiry';

const turn = (i: number, toolName?: string, args: object = {}) => [
  new HumanMessage({ id: `h${i}`, content: `question ${i}` }),
  ...(toolName
    ? [
        new AIMessage({
          id: `a${i}`,
          content: '',
          tool_calls: [{ id: `c${i}`, name: toolName, args }],
        }),
        new ToolMessage({ id: `t${i}`, tool_call_id: `c${i}`, content: 'ok' }),
      ]
    : []),
  new AIMessage({ id: `r${i}`, content: `answer ${i}` }),
];

const pluginOf = (toolName: string) =>
  ({ flow_run: 'flows', vfs_read: 'vfs' })[toolName];

const idle = (messages: BaseMessage[], maxIdleTurns = 3) =>
  idlePlugins({
    messages,
    loaded: ['flows', 'vfs'],
    pluginOf,
    maxIdleTurns,
  });

describe('idlePlugins', () => {
  it('names the plugins no recent turn touched', () => {
    const history = [
      turn(0, 'flow_run'),
      turn(1),
      turn(2, 'vfs_read'),
      turn(3),
    ].flat();
    expect(idle(history)).toEqual(['flows']);
  });

  it('counts a load as a use, by the names it was given', () => {
    const history = [
      turn(0, 'load_capability', { names: ['flows'] }),
      turn(1),
      turn(2),
    ].flat();
    expect(idle(history)).toEqual(['vfs']);
  });

  it('unloads nothing while the thread is shorter than the window, or when it is off', () => {
    expect(idle([turn(0), turn(1)].flat())).toEqual([]);
    expect(idle([turn(0), turn(1), turn(2)].flat(), 0)).toEqual([]);
  });

  it('survives a load call with malformed arguments', () => {
    const history = [
      turn(0, 'load_capability', { names: 'flows' }),
      turn(1),
      turn(2),
    ].flat();
    expect(idle(history)).toEqual(['flows', 'vfs']);
  });
});
