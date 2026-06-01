import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createTestRuntime,
  makeManifest,
  makePlugin,
  makeMiddleware,
  makeSubAgent,
  makeTool,
  mockResponse,
} from './index.js';

describe('createTestRuntime', () => {
  it('constructs an empty runtime without errors', async () => {
    const rt = await createTestRuntime({ plugins: [] });
    expect(rt.listTools()).toEqual([]);
    expect(rt.listCapabilities()).toEqual([]);
    await rt.close();
  });

  it('boots a single-plugin harness in under 500ms', async () => {
    const start = performance.now();
    const rt = await createTestRuntime({
      plugins: [
        makePlugin({
          name: 'climate',
          getTools: () => [makeTool('get_emissions')],
        }),
      ],
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(rt.listTools().map((t) => t.name)).toEqual(['get_emissions']);
    await rt.close();
  });

  it('invokes a tool with valid args and returns its result', async () => {
    const handler = vi.fn(async (args: unknown) => ({
      echoed: args,
      ok: true,
    }));
    const rt = await createTestRuntime({
      plugins: [
        makePlugin({
          name: 'climate',
          getTools: () => [
            makeTool('get_emissions', {
              schema: z.object({ facilityId: z.string() }),
              handler,
            }),
          ],
        }),
      ],
    });

    const result = await rt.invokeTool('get_emissions', {
      facilityId: 'plant-42',
    });

    expect(result).toEqual({
      echoed: { facilityId: 'plant-42' },
      ok: true,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    const ctx = handler.mock.calls[0]![1] as { user: { did: string } };
    expect(ctx.user.did).toBe('did:ixo:test-user');
  });

  it('threads user/session overrides into the synthesized RuntimeContext', async () => {
    const captured: Array<{ did: string; sessionId: string }> = [];
    const rt = await createTestRuntime({
      plugins: [
        makePlugin({
          name: 'p',
          getTools: () => [
            makeTool('whoami', {
              handler: async (_a, ctx) => {
                captured.push({ did: ctx.user.did, sessionId: ctx.session.id });
                return ctx.user.did;
              },
            }),
          ],
        }),
      ],
      user: { did: 'did:ixo:override' },
      session: { id: 'session-X' },
    });
    const result = await rt.invokeTool('whoami', {});
    expect(result).toBe('did:ixo:override');
    expect(captured[0]).toEqual({
      did: 'did:ixo:override',
      sessionId: 'session-X',
    });
  });

  it('throws a descriptive error when a tool is not registered', async () => {
    const rt = await createTestRuntime({
      plugins: [
        makePlugin({
          name: 'p',
          getTools: () => [makeTool('only_this')],
        }),
      ],
    });
    await expect(rt.invokeTool('nope', {})).rejects.toThrow(
      /Tool "nope" not found.*only_this/,
    );
  });

  it('listTools filters by plugin', async () => {
    const rt = await createTestRuntime({
      plugins: [
        makePlugin({
          name: 'a',
          getTools: () => [makeTool('a1'), makeTool('a2')],
        }),
        makePlugin({
          name: 'b',
          getTools: () => [makeTool('b1')],
        }),
      ],
    });
    expect(rt.listTools('a').map((t) => t.name)).toEqual(['a1', 'a2']);
    expect(rt.listTools('b').map((t) => t.name)).toEqual(['b1']);
    expect(rt.listTools().map((t) => t.name)).toEqual(['a1', 'a2', 'b1']);
  });

  it('invokeMiddleware runs the named middleware hooks', async () => {
    const beforeAgent = vi.fn(async () => ({ before: 'ran' }));
    const afterAgent = vi.fn(async () => ({ after: 'ran' }));
    const mw = makeMiddleware('myMiddleware');
    Object.assign(mw, { beforeAgent, afterAgent });

    const rt = await createTestRuntime({
      plugins: [makePlugin({ name: 'p', getMiddlewares: () => [mw] })],
    });

    const out = await rt.invokeMiddleware('myMiddleware', { x: 1 });
    expect(beforeAgent).toHaveBeenCalled();
    expect(afterAgent).toHaveBeenCalled();
    expect(out.before).toEqual({ before: 'ran' });
    expect(out.after).toEqual({ after: 'ran' });
  });

  it('invokeMiddleware accepts a numeric index for anonymous fixtures', async () => {
    const beforeModel = vi.fn(async () => ({ touched: true }));
    const mw = makeMiddleware('mw0');
    Object.assign(mw, { beforeModel });
    const rt = await createTestRuntime({
      plugins: [makePlugin({ name: 'p', getMiddlewares: () => [mw] })],
    });
    const out = await rt.invokeMiddleware(0, {});
    expect(beforeModel).toHaveBeenCalled();
    expect(out.before).toEqual({ touched: true });
  });

  it('loadCapability marks a plugin loaded and updates listCapabilities', async () => {
    const rt = await createTestRuntime({
      plugins: [
        makePlugin({
          name: 'climate',
          manifest: makeManifest({ visibility: 'on-demand' }),
        }),
      ],
    });
    const before = rt.listCapabilities();
    expect(before[0]!.loaded).toBe(false);

    rt.loadCapability('climate');

    const after = rt.listCapabilities();
    expect(after[0]!.loaded).toBe(true);
  });

  it('loadCapability throws on unknown or silent plugins', async () => {
    const rt = await createTestRuntime({
      plugins: [
        makePlugin({
          name: 'silent',
          manifest: makeManifest({ visibility: 'silent' }),
        }),
      ],
    });
    expect(() => rt.loadCapability('nope')).toThrow(/not registered/);
    expect(() => rt.loadCapability('silent')).toThrow(/silent/);
  });

  it('assertNoCollisions throws when two plugins share a tool name', async () => {
    const rt = await createTestRuntime({
      plugins: [
        makePlugin({
          name: 'a',
          getTools: () => [makeTool('shared')],
        }),
        makePlugin({
          name: 'b',
          getTools: () => [makeTool('shared')],
        }),
      ],
    });
    expect(() => rt.assertNoCollisions()).toThrow(/shared.*a.*b/);
  });

  it('assertManifestValid throws on invalid manifests', async () => {
    const rt = await createTestRuntime({
      plugins: [
        makePlugin({
          name: 'broken',
          manifest: makeManifest({
            // empty summary — fails the "non-empty" hard rule.
            summary: '   ',
            // also try an uppercase tag — fails the lowercase hard rule.
            tags: ['BadTag'],
          }),
        }),
      ],
    });
    expect(() => rt.assertManifestValid()).toThrow(
      /Manifest validation failed/,
    );
  });

  it('getManifest returns the registered manifest, throws on unknown plugin', async () => {
    const rt = await createTestRuntime({
      plugins: [
        makePlugin({
          name: 'p',
          manifest: makeManifest({ title: 'Plug' }),
        }),
      ],
    });
    expect(rt.getManifest('p').title).toBe('Plug');
    expect(() => rt.getManifest('nope')).toThrow(/not registered/);
  });

  it('mockResponse builds a Response-like envelope readable as JSON or text', async () => {
    const r = mockResponse({ co2: 1234 }, { status: 201 });
    expect(r.status).toBe(201);
    expect(r.ok).toBe(true);
    await expect(r.json()).resolves.toEqual({ co2: 1234 });
    await expect(r.text()).resolves.toBe('{"co2":1234}');
  });

  it('mocks.fetch swaps the active fetch handler', async () => {
    const rt = await createTestRuntime({ plugins: [] });
    const handler = vi.fn((url: string) => mockResponse({ url }));
    rt.mocks.fetch(handler);
    // Plugin authors invoke the handler directly via `_fetchHandler` —
    // assert the swap took.
    const stored = (rt as unknown as { _fetchHandler: typeof handler })
      ._fetchHandler;
    expect(stored).toBe(handler);
    const r = stored('http://test') as { json: () => Promise<unknown> };
    expect(await r.json()).toEqual({ url: 'http://test' });
  });

  it('mocks.matrix swaps the matrix adapter for subsequent invocations', async () => {
    const rt = await createTestRuntime({
      plugins: [
        makePlugin({
          name: 'p',
          getTools: () => [
            makeTool('post', {
              handler: async (_a, ctx) =>
                ctx.matrix.postToRoom('!room:example', { hi: 1 }),
            }),
          ],
        }),
      ],
    });

    const customPost = vi.fn(async () => 'custom-event-id');
    rt.mocks.matrix({ postToRoom: customPost });

    const out = await rt.invokeTool('post', {});
    expect(out).toBe('custom-event-id');
    expect(customPost).toHaveBeenCalledWith('!room:example', { hi: 1 });
  });

  it('invokeAgent throws a clear not-implemented error', async () => {
    const rt = await createTestRuntime({ plugins: [] });
    await expect(rt.invokeAgent([])).rejects.toThrow(/not implemented/);
  });

  it('invokeSubAgent returns a deterministic envelope using the configured llm mock', async () => {
    const rt = await createTestRuntime({
      plugins: [
        makePlugin({
          name: 'p',
          getSubAgents: () => [
            makeSubAgent('memory_agent', {
              systemPrompt: 'You are the memory agent for the oracle.',
              tools: [makeTool('remember')],
            }),
          ],
        }),
      ],
      mocks: { llm: { respondWith: 'fake-llm-reply' } },
    });

    const replyJson = await rt.invokeSubAgent(
      'memory_agent',
      'remember the user is named Alice',
    );
    const parsed = JSON.parse(replyJson) as {
      subAgent: string;
      toolNames: string[];
      reply: string;
    };
    expect(parsed.subAgent).toBe('memory_agent');
    expect(parsed.toolNames).toEqual(['remember']);
    expect(parsed.reply).toBe('fake-llm-reply');
  });

  it('feature toggles flow through to the production loader', async () => {
    const rt = await createTestRuntime({
      plugins: [
        makePlugin({
          name: 'a',
          getTools: () => [makeTool('a1')],
        }),
        makePlugin({
          name: 'b',
          getTools: () => [makeTool('b1')],
        }),
      ],
      features: { b: false },
    });
    expect(rt.listTools().map((t) => t.name)).toEqual(['a1']);
  });
});
