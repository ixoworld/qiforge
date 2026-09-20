import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineDecision } from '@ixo/decisions';
import { createRuntimeCore } from './index';
import { makeEnv, makePlugin, makeRuntimeContext } from './test-fixtures';

const definition = defineDecision({
  name: 'test.classify',
  version: '1',
  description: 'Classify projected text.',
  inputSchema: z.object({
    text: z.string(),
    privateHistory: z.string().optional(),
  }),
  project: ({ text }) => ({
    state: { text },
    questions: {
      yes: { kind: 'boolean', instructions: 'Does this request help?' },
    },
  }),
});
function plugin(name = 'test') {
  const result = makePlugin({ name });
  result.getDecisions = () => [definition];
  return result;
}
const response = {
  model: 'jev-1.13.0',
  answers: { yes: { type: 'noul', noul: 0.8 } },
};
afterEach(() => vi.restoreAllMocks());

describe('Workers Decisions boot and turn path', () => {
  it.each(['cloudflare-jev', 'openrouter-jev'])(
    'evaluates a plugin Decision through %s from the turn context',
    async (provider) => {
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(Response.json(response));
      const core = createRuntimeCore({
        config: { name: 'Test' },
        plugins: [plugin()],
        env: makeEnv({
          DECISION_PROVIDER: provider,
          CLOUDFLARE_ACCOUNT_ID: 'account',
          CLOUDFLARE_API_TOKEN: 'cloudflare-secret',
        }),
      });
      const ctx = makeRuntimeContext(
        {},
        { ambient: { decisions: core.decisions } },
      );
      const result = await ctx.decisions.evaluateByName('test.classify', {
        text: 'Please help',
        privateHistory: 'never send',
      });
      expect(result.provider).toBe(
        provider === 'cloudflare-jev' ? 'cloudflare' : 'openrouter',
      );
      expect(result.answers.yes).toEqual({
        kind: 'boolean',
        probabilityTrue: 0.8,
      });
      expect(String(fetch.mock.calls[0]?.[1]?.body)).not.toContain(
        'never send',
      );
      expect(core.validatedEnv).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
      await core.warm();
      expect(core.registries.tools.toolNames()).not.toContain('test.classify');
    },
  );

  it('honours explicit host adapters without requiring provider credentials', async () => {
    const core = createRuntimeCore({
      config: { name: 'Test' },
      plugins: [plugin()],
      env: makeEnv({ DECISION_PROVIDER: 'cloudflare-jev' }),
      decisionAdapter: {
        provider: 'host',
        model: 'host',
        async evaluate() {
          return {
            answers: { yes: { kind: 'boolean', probabilityTrue: 0.5 } },
          };
        },
      },
    });
    expect(
      (await core.decisions.evaluateByName('test.classify', { text: 'help' }))
        .provider,
    ).toBe('host');
  });

  it('fails boot on missing provider credentials and unknown providers', () => {
    for (const provider of ['cloudflare-jev', 'mistyped-provider']) {
      expect(() =>
        createRuntimeCore({
          config: { name: 'Test' },
          plugins: [],
          env: makeEnv({ DECISION_PROVIDER: provider }),
        }),
      ).toThrow();
    }
  });

  it('rejects duplicate registrations including duplicates within one plugin', () => {
    const repeated = plugin();
    repeated.getDecisions = () => [definition, definition];
    for (const plugins of [[plugin('first'), plugin('second')], [repeated]]) {
      expect(() =>
        createRuntimeCore({
          config: { name: 'Test' },
          plugins,
          env: makeEnv(),
        }),
      ).toThrow('Duplicate Decision');
    }
  });

  it('never registers disabled plugins', async () => {
    const core = createRuntimeCore({
      config: { name: 'Test' },
      plugins: [plugin()],
      features: { test: false },
      env: makeEnv(),
    });
    await expect(
      core.decisions.evaluateByName('test.classify', {}),
    ).rejects.toThrow('not registered');
  });

  it('aborts the evaluation when the owning turn is superseded', async () => {
    const controller = new AbortController();
    const core = createRuntimeCore({
      config: { name: 'Test' },
      plugins: [plugin()],
      env: makeEnv(),
      decisionAdapter: {
        provider: 'test',
        model: 'test',
        evaluate: () => new Promise(() => undefined),
      },
    });
    const ctx = makeRuntimeContext(
      {},
      {
        ambient: { decisions: core.decisions },
        runConfig: { signal: controller.signal },
      },
    );
    const pending = ctx.decisions.evaluateByName(
      'test.classify',
      { text: 'help' },
      { signal: new AbortController().signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
