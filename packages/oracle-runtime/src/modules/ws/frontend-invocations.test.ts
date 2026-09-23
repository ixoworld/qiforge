import { describe, expect, it, vi } from 'vitest';
import { FrontendInvocations } from './frontend-invocations.js';

const socket = (
  id: string,
  sessionId = 'topic-a',
  userDid = 'did:ixo:alice',
) => ({ id, connected: true, data: { sessionId, userDid }, emit: vi.fn() });

describe.each(['browser_tool_call', 'action_call'] as const)(
  '%s executor routing',
  (kind) => {
    const resultKind =
      kind === 'browser_tool_call'
        ? 'browser_tool_result'
        : 'action_call_result';
    it('executes on one authenticated socket, accepting only its first matching result', () => {
      const router = new FrontendInvocations();
      const a = socket('a'),
        b = socket('b'),
        other = socket('other', 'topic-b');
      const call = { sessionId: 'topic-a', toolCallId: 'invocation-1' };
      expect(router.dispatch(kind, call, [other, a, b])).toBe(true);
      expect(a.emit).toHaveBeenCalledOnce();
      expect(b.emit).not.toHaveBeenCalled();
      expect(other.emit).not.toHaveBeenCalled();
      expect(router.accept(resultKind, b, 'topic-a', 'invocation-1')).toBe(
        false,
      );
      expect(router.accept(resultKind, a, 'topic-a', 'unissued')).toBe(false);
      expect(router.accept(resultKind, a, 'topic-b', 'invocation-1')).toBe(
        false,
      );
      expect(router.accept(resultKind, a, 'topic-a', 'invocation-1')).toBe(
        true,
      );
      expect(router.accept(resultKind, a, 'topic-a', 'invocation-1')).toBe(
        false,
      );
      expect(router.dispatch(kind, call, [b])).toBe(false);
    });
    it('does not redirect a pending write when its executor disconnects', () => {
      const router = new FrontendInvocations();
      const a = socket('a'),
        b = socket('b');
      const call = { sessionId: 'topic-a', toolCallId: 'invocation-2' };
      router.dispatch(kind, call, [a, b]);
      a.connected = false;
      expect(router.dispatch(kind, call, [b])).toBe(false);
      expect(b.emit).not.toHaveBeenCalled();
      a.data.userDid = 'did:ixo:bob';
      expect(router.accept(resultKind, a, 'topic-a', 'invocation-2')).toBe(
        false,
      );
    });
  },
);

it('keeps capacity available after completed calls while retaining pending calls', () => {
  let now = 0;
  const router = new FrontendInvocations(() => now, 2);
  const a = socket('a');
  const call = (toolCallId: string) => ({ sessionId: 'topic-a', toolCallId });
  expect(router.dispatch('browser_tool_call', call('one'), [a])).toBe(true);
  expect(router.dispatch('browser_tool_call', call('two'), [a])).toBe(true);
  expect(router.dispatch('browser_tool_call', call('three'), [a])).toBe(false);
  expect(router.accept('browser_tool_result', a, 'topic-a', 'one')).toBe(true);
  expect(router.dispatch('browser_tool_call', call('three'), [a])).toBe(true);
  expect(router.dispatch('browser_tool_call', call('two'), [a])).toBe(false);
  now = 31 * 60_000;
  expect(router.dispatch('browser_tool_call', call('two'), [a])).toBe(true);
});
