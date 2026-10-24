import { catalog } from '@ixo/agent-tools';
import { describe, expect, it, vi } from 'vitest';
import type { IxoToolsSurface } from '../../ixo-tools/surface';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { makeRunConfig } from '../../core/test-fixtures';
import {
  buildRuntimeContext,
  createNoopAmbient,
} from '../../core/runtime-context';
import { IxoToolsPlugin } from './ixo-tools.plugin';

describe('IxoToolsPlugin', () => {
  it('forwards a host facade only to its matching run scope', () => {
    const surface: IxoToolsSurface = {
      discover: async () => ({ status: 'available', tools: [] }),
      invoke: async () => ({ status: 'unauthorized', reason: 'scope_denied' }),
    };
    const scope = {
      userDid: 'did:ixo:user1',
      sessionId: 'session-1',
      roomId: 'room-1',
      timezone: 'UTC',
    };
    const ambient = createNoopAmbient({ ixoTools: { scope, tools: surface } });
    const run = makeRunConfig({
      context: {
        ...makeRunConfig().context,
        user: { ...makeRunConfig().context.user, timezone: 'UTC' },
        session: { ...makeRunConfig().context.session, roomId: 'room-1' },
      },
    });
    const state = { messages: [] };
    expect(buildRuntimeContext(run, ambient, state).ixoTools).toBe(surface);
    expect(
      buildRuntimeContext(
        {
          ...run,
          context: {
            ...run.context,
            user: { ...run.context.user, did: 'did:ixo:other' },
          },
        },
        ambient,
        state,
      ).ixoTools,
    ).toBeUndefined();
    expect(
      buildRuntimeContext(
        {
          ...run,
          context: {
            ...run.context,
            session: { ...run.context.session, id: 'other' },
          },
        },
        ambient,
        state,
      ).ixoTools,
    ).toBeUndefined();
    expect(
      buildRuntimeContext(
        {
          ...run,
          context: {
            ...run.context,
            session: { ...run.context.session, roomId: 'other' },
          },
        },
        ambient,
        state,
      ).ixoTools,
    ).toBeUndefined();
    expect(
      buildRuntimeContext(
        {
          ...run,
          context: {
            ...run.context,
            user: { ...run.context.user, timezone: 'Asia/Singapore' },
          },
        },
        ambient,
        state,
      ).ixoTools,
    ).toBeUndefined();
  });

  it('strictly converts all catalog schemas and keeps every descriptor read-only', async () => {
    const plugin = new IxoToolsPlugin();
    const surface: IxoToolsSurface = {
      discover: async () => ({
        status: 'available',
        tools: catalog.map((tool) => tool.name),
      }),
      invoke: async () => ({ status: 'unauthorized', reason: 'scope_denied' }),
    };
    const tools = await plugin.getRequestTools(
      makeRuntimeContext({ ixoTools: surface }),
    );
    expect(tools.map(({ name }) => name)).toEqual(
      catalog.map(({ name }) => name),
    );
    expect(tools.every(({ effect }) => effect === 'read')).toBe(true);
    const error = tools.find(({ name }) => name === 'ixo_error_explain');
    expect(error?.schema.safeParse({ errorText: 'oops' }).success).toBe(true);
    expect(error?.schema.safeParse({ errorId: 'err-1' }).success).toBe(true);
    expect(
      error?.schema.safeParse({ errorText: 'oops', errorId: 'err-1' }).success,
    ).toBe(false);
    expect(
      error?.schema.safeParse({
        errorText: 'oops',
        endpoint: 'https://attacker.example',
      }).success,
    ).toBe(false);
    const account = tools.find(({ name }) => name === 'ixo_account_get');
    expect(
      account?.schema.safeParse({ userDid: 'did:ixo:someone' }).success,
    ).toBe(false);
  });

  it('uses the pinned facade and refuses a later context override', async () => {
    const invoke = vi.fn(async () => ({
      status: 'unauthorized' as const,
      reason: 'scope_denied' as const,
    }));
    const surface: IxoToolsSurface = {
      discover: async () => ({
        status: 'available',
        tools: ['ixo_account_get'],
      }),
      invoke,
    };
    const ctx = makeRuntimeContext({ ixoTools: surface });
    const plugin = new IxoToolsPlugin();
    const tools = await plugin.getRequestTools(ctx);
    const account = tools.find(({ name }) => name === 'ixo_account_get');
    if (!account) throw new Error('account tool missing');
    await account.handler({}, ctx);
    expect(invoke).toHaveBeenCalledWith('ixo_account_get', {});
    const mismatched = makeRuntimeContext({
      ixoTools: surface,
      user: { ...ctx.user, did: 'did:ixo:other' },
    });
    expect(await account.handler({}, mismatched)).toEqual({
      status: 'unauthorized',
      reason: 'scope_denied',
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    const replaced = makeRuntimeContext({ ixoTools: { ...surface } });
    expect(await account.handler({}, replaced)).toEqual({
      status: 'unauthorized',
      reason: 'scope_denied',
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('contributes no tools when discovery is unavailable', async () => {
    const surface: IxoToolsSurface = {
      discover: async () => ({
        status: 'unavailable',
        reason: 'source_unavailable',
        retryable: true,
      }),
      invoke: async () => ({ status: 'unauthorized', reason: 'scope_denied' }),
    };
    expect(
      await new IxoToolsPlugin().getRequestTools(
        makeRuntimeContext({ ixoTools: surface }),
      ),
    ).toEqual([]);
  });
});
