import { SystemMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { createPageContextMiddleware } from './page-context-middleware.js';

describe('createPageContextMiddleware', () => {
  it('passes through unchanged when no editorRoomId is set', async () => {
    const getRoomTitle = vi.fn().mockResolvedValue('Untitled');
    const mw = createPageContextMiddleware({ getRoomTitle });
    const wrap = mw.wrapModelCall;
    if (!wrap) throw new Error('wrapModelCall missing');

    const baseSystem = new SystemMessage('base');
    const handler = vi.fn().mockResolvedValue({ ok: true });

    await wrap(
      { state: {}, systemMessage: baseSystem } as never,
      handler as never,
    );

    expect(getRoomTitle).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
    const passedRequest = handler.mock.calls[0][0] as {
      systemMessage: SystemMessage;
    };
    // Untouched
    expect(passedRequest.systemMessage).toBe(baseSystem);
  });

  it('appends a current-page block when editorRoomId is set', async () => {
    const getRoomTitle = vi.fn().mockResolvedValue('My Doc');
    const mw = createPageContextMiddleware({ getRoomTitle });
    const wrap = mw.wrapModelCall;
    if (!wrap) throw new Error('wrapModelCall missing');

    const baseSystem = new SystemMessage('base');
    const handler = vi.fn().mockResolvedValue({ ok: true });

    await wrap(
      {
        state: { editorRoomId: '!room1:ixo' },
        systemMessage: baseSystem,
      } as never,
      handler as never,
    );

    const passed = handler.mock.calls[0][0] as { systemMessage: SystemMessage };
    expect(String(passed.systemMessage.content)).toContain(
      'Active Page Context',
    );
    expect(String(passed.systemMessage.content)).toContain('"My Doc"');
    expect(String(passed.systemMessage.content)).toContain('!room1:ixo');
  });

  it('flags page switches when previousEditorRoomId differs', async () => {
    const getRoomTitle = vi
      .fn()
      .mockImplementation(async (id: string) =>
        id === '!new:ixo' ? 'New Page' : 'Old Page',
      );
    const mw = createPageContextMiddleware({ getRoomTitle });
    const wrap = mw.wrapModelCall;
    if (!wrap) throw new Error('wrapModelCall missing');

    const handler = vi.fn().mockResolvedValue({ ok: true });

    await wrap(
      {
        state: {
          editorRoomId: '!new:ixo',
          _previousEditorRoomId: '!old:ixo',
        },
        systemMessage: new SystemMessage('base'),
      } as never,
      handler as never,
    );

    const passed = handler.mock.calls[0][0] as { systemMessage: SystemMessage };
    expect(String(passed.systemMessage.content)).toContain(
      'switched pages',
    );
    expect(String(passed.systemMessage.content)).toContain('!new:ixo');
    expect(String(passed.systemMessage.content)).toContain('!old:ixo');
  });

  it('afterModel records the new editorRoomId when it changes', () => {
    const mw = createPageContextMiddleware({
      getRoomTitle: async () => undefined,
    });
    const after = mw.afterModel;
    if (typeof after !== 'function') throw new Error('afterModel missing');

    const result = after(
      { editorRoomId: '!new:ixo', _previousEditorRoomId: undefined } as never,
      undefined as never,
    );
    expect(result).toEqual({ _previousEditorRoomId: '!new:ixo' });
  });

  it('afterModel returns undefined when editorRoomId is unchanged', () => {
    const mw = createPageContextMiddleware({
      getRoomTitle: async () => undefined,
    });
    const after = mw.afterModel;
    if (typeof after !== 'function') throw new Error('afterModel missing');

    const result = after(
      {
        editorRoomId: '!same:ixo',
        _previousEditorRoomId: '!same:ixo',
      } as never,
      undefined as never,
    );
    expect(result).toBeUndefined();
  });
});
