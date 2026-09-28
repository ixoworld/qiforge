import { FakeListChatModel } from '@langchain/core/utils/testing';
import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeCore } from '../core';
import { createNoopAmbient } from '../core/runtime-context';
import { makeEnv } from '../core/test-fixtures';
import { ToolScheduler } from '../core/tool-scheduler';
import { createUserOracleDO } from './user-oracle-do';

describe('supplied-context turn preparation', () => {
  it.each([false, true])(
    'skips external context and retains the model budget (resumed=%s)',
    async (resumed) => {
      const forbidden = vi.fn(() => {
        throw new Error('Unapproved enrichment');
      });
      const core = createRuntimeCore({
        config: { name: 'Test', org: 'Test', description: 'Test' },
        plugins: [],
        env: makeEnv(),
      });
      const ambient = createNoopAmbient({
        config: core.validatedEnv,
        identity: core.identity,
        availablePlugins: core.availablePlugins,
        llm: { get: () => new FakeListChatModel({ responses: ['# Brief'] }) },
      });
      const saver = Object.assign(new MemorySaver(), {
        getTupleWithoutMessages: async () => undefined,
      });
      const host = {
        core,
        ambient,
        saver,
        env: {},
        taskScheduler: { assertTurnProfile: vi.fn(async () => {}) },
        sessions: { getSession: async () => ({ id: 'task:one' }) },
        contextWindows: {
          resolve: async () => ({
            model: 'test',
            tokens: 100000,
            origin: 'default',
          }),
        },
        aborts: new Map(),
        shadowRoutes: new Map(),
        toolScheduler: new ToolScheduler(),
        runStore: { update: vi.fn(async () => {}) },
        preferences: { get: forbidden },
        capabilityRouter: forbidden,
        attachmentViewSurface: forbidden,
        sandboxArchiveConfig: forbidden,
        get gateway() {
          return forbidden();
        },
      };
      const Oracle = createUserOracleDO({
        core: () => core,
        hooks: { getRoomTitle: forbidden, safetyModel: forbidden },
      });
      const prepare = Reflect.get(Oracle.prototype, 'prepareTurn');
      const controller = new AbortController();
      const prepared = (await Reflect.apply(prepare, host, [
        {
          identity: {
            userDid: 'did:ixo:owner',
            matrixUserId: '@owner:example.org',
          },
          sessionId: 'task:one',
          message: 'Only authorized text',
          client: 'matrix',
          requestId: 'request',
          taskRunId: 'run',
          executionProfile: 'supplied-context-markdown',
        },
        { message: 'Only authorized text' },
        {
          runId: 'run',
          abortController: controller,
          resumed,
          continuation: null,
        },
      ])) as Awaited<ReturnType<InstanceType<typeof Oracle>['prepareTurn']>>;
      try {
        const result = await prepared.agent.invoke(
          prepared.stateInput,
          prepared.config,
        );
        expect(result.messages.at(-1).content).toBe('# Brief');
        expect(forbidden).not.toHaveBeenCalled();
        expect(prepared.config.signal).toBe(controller.signal);
      } finally {
        for (const dispose of prepared.turnDisposables) await dispose();
      }
      expect(host.runStore.update).toHaveBeenCalledWith(
        'run',
        expect.objectContaining({
          usage: expect.stringContaining('"modelCalls":1'),
        }),
      );
    },
  );
});
