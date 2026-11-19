/**
 * A plugin's wake (`ctx.requestWake` → `OraclePlugin.onWake`): the earliest
 * requested wake is kept and armed on the object's alarm; the housekeeping
 * tick calls every `onWake` once it is due, with the person the object
 * serves and no run, and returns any wake requested again.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRuntimeCore } from '../core';
import { createNoopAmbient } from '../core/runtime-context';
import { makeEnv, makePlugin } from '../core/test-fixtures';
import type { RuntimeContext } from '../plugin-api/types';
import { createUserOracleDO } from './user-oracle-do';

async function call(
  object: object,
  name: string,
  ...args: unknown[]
): Promise<unknown> {
  const method: unknown = Reflect.get(object, name);
  if (typeof method !== 'function')
    throw new Error(`Missing host method ${name}`);
  return Reflect.apply(method, object, args);
}

function hostWith(
  state: DurableObjectState,
  onWake: (ctx: RuntimeContext) => void | Promise<void>,
) {
  const core = createRuntimeCore({
    config: { name: 'Test' },
    env: makeEnv(),
    plugins: [
      makePlugin({
        name: 'billing',
        onWake: (ctx) => onWake(ctx),
      }),
    ],
  });
  const UserOracleDO = createUserOracleDO({ core: () => core });
  const host: object = Object.create(UserOracleDO.prototype);
  Object.assign(host, {
    ctx: state,
    env: { ORACLE_DID: 'did:ixo:test' },
    userDid: 'did:ixo:alice',
    // As the object builds it when a plugin defines `onWake`.
    ambient: createNoopAmbient({
      requestWake: async (at: number) => {
        await call(host, 'requestPluginWake', at);
      },
    }),
    delegations: new Map(),
    turnDelegation: async () => ({ raw: 'deposited' }),
    alarmArm: Promise.resolve(),
    housekeepingFloor: Infinity,
  });
  return host;
}

describe('plugin wake', () => {
  it('keeps the earliest requested wake and arms the alarm for it', async () => {
    const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName('wake-arm'));
    await runInDurableObject(stub, async (_instance, state) => {
      const host = hostWith(state, () => undefined);
      const now = Date.now();
      await call(host, 'requestPluginWake', now + 120_000);
      await call(host, 'requestPluginWake', now + 60_000);
      await call(host, 'requestPluginWake', now + 300_000);
      expect(await state.storage.get('meta:pluginWakeAt')).toBe(now + 60_000);
      const alarm = await state.storage.getAlarm();
      expect(alarm ?? Infinity).toBeLessThanOrEqual(now + 60_000);
      await state.storage.deleteAlarm();
    });
  });

  it('calls onWake once it is due, with the person and no run, and returns a wake asked for again', async () => {
    const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName('wake-due'));
    await runInDurableObject(stub, async (_instance, state) => {
      const seen: RuntimeContext[] = [];
      const host = hostWith(state, async (ctx) => {
        seen.push(ctx);
        await ctx.requestWake?.(Date.now() + 600_000);
      });
      const now = Date.now();
      await state.storage.put('meta:pluginWakeAt', now + 60_000);
      // Not due yet: nothing is called, the pending wake is returned.
      expect(await call(host, 'pluginWakeTick', now)).toBe(now + 60_000);
      expect(seen).toHaveLength(0);
      // Due: called once, with the deposited delegation and no run.
      const next = await call(host, 'pluginWakeTick', now + 61_000);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        user: { did: 'did:ixo:alice', ucanDelegation: { raw: 'deposited' } },
      });
      expect(seen[0]?.session.runId).toBeUndefined();
      expect(typeof next).toBe('number');
      expect(next).toBeGreaterThan(now + 500_000);
      await state.storage.deleteAlarm();
    });
  });

  it('a failing onWake is logged and the wake is cleared', async () => {
    const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName('wake-fail'));
    await runInDurableObject(stub, async (_instance, state) => {
      const host = hostWith(state, () => {
        throw new Error('engine down');
      });
      await state.storage.put('meta:pluginWakeAt', Date.now() - 1);
      expect(await call(host, 'pluginWakeTick', Date.now())).toBeNull();
      expect(await state.storage.get('meta:pluginWakeAt')).toBeUndefined();
    });
  });
});
