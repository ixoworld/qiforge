import { expect, expectTypeOf, test } from 'vitest';
import {
  createAgentToolsHost,
  type Adapters,
  type AdapterInput,
  type Available,
  type ContextToken,
  type HostFacts,
  type ToolInput,
  type ToolValue,
  type ToolName,
} from '../src/index.js';

test('literal tool invocation preserves schema-derived output types', async () => {
  const host = createAgentToolsHost();
  const context = host.bindContext({
    userDid: 'u',
    oracleDid: 'o',
    network: 'devnet',
    sessionId: 's',
    roomId: 'r',
    visibility: 'private',
    timezone: 'UTC',
  });
  const result = await host.invoke(context, 'ixo_credits_get', {});
  if (result.status === 'available') {
    expectTypeOf(result.value.amount).toEqualTypeOf<string>();
    expectTypeOf(result.value.denomination).toEqualTypeOf<'upay'>();
    expectTypeOf(result.value.decimals).toEqualTypeOf<3>();
    expectTypeOf(result.value).not.toHaveProperty('knowledge');
    expectTypeOf(result.value).toEqualTypeOf<
      Readonly<ToolValue<'ixo_credits_get'>>
    >();
  }
  expect(result).toEqual({ status: 'unauthorized', reason: 'grant_missing' });
  const dynamic: unknown = 'ixo_concept_get';
  const dynamicResult = await host.invoke(context, dynamic, {
    concept: 'Topic',
  });
  if (dynamicResult.status === 'available')
    expectTypeOf(dynamicResult).toEqualTypeOf<Available<ToolName>>();
});

test('adapter inputs and model arguments keep their distinct file time contracts', async () => {
  const adapters = {
    ixo_files_find: ({ context, input }) => {
      expectTypeOf(context).toEqualTypeOf<HostFacts>();
      expectTypeOf(input.when).toEqualTypeOf<
        Readonly<{ calendarDate: string; timezone: string }> | undefined
      >();
      return { version: 1, status: 'unavailable' };
    },
    ixo_offramp_quote: {
      reviewed: true,
      invoke: ({ input }) => {
        expectTypeOf(input.asset).toEqualTypeOf<'USDC'>();
        expectTypeOf(input.amount).toEqualTypeOf<string>();
        return { version: 1, status: 'unavailable' };
      },
    },
  } satisfies Adapters;
  const host = createAgentToolsHost({
    adapters,
    now: () => Date.parse('2026-10-24T12:00:00Z'),
    readGrants: (context) => [
      { ...context, tool: 'ixo_files_find', expiresAt: '2026-10-24T13:00:00Z' },
    ],
    resourceAccess: () => true,
  });
  const token = host.bindContext({
    userDid: 'u',
    oracleDid: 'o',
    network: 'devnet',
    sessionId: 's',
    roomId: 'r',
    visibility: 'private',
    timezone: 'UTC',
  });
  expect(
    await host.invoke(token, 'ixo_files_find', {
      query: 'upload',
      when: 'yesterday',
    }),
  ).toEqual({
    status: 'unavailable',
    reason: 'source_unavailable',
    retryable: true,
  });
  expectTypeOf<ToolInput<'ixo_files_find'>['when']>().toEqualTypeOf<
    'yesterday' | undefined
  >();
  expectTypeOf<ToolValue<'ixo_memory_personal_search'>>().toHaveProperty(
    'facts',
  );
  expectTypeOf<AdapterInput<'ixo_credits_get'>>().not.toBeAny();
  expectTypeOf<object>().not.toExtend<ContextToken>();
});
