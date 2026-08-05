import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tool } from './tool-helper.js';

const handler = async (): Promise<string> => 'ok';
const base = {
  name: 'do_thing',
  description: 'Does the thing.',
  schema: z.object({ id: z.string() }),
};

describe('tool()', () => {
  it('builds a plugin tool from a handler and descriptor', () => {
    const built = tool(handler, base);
    expect(built.name).toBe('do_thing');
    expect(built.description).toBe('Does the thing.');
    expect(built.handler).toBe(handler);
  });

  it('omits optional fields that were not supplied', () => {
    const built = tool(handler, base);
    expect(built).not.toHaveProperty('visibility');
    expect(built).not.toHaveProperty('effect');
  });

  it('carries visibility through', () => {
    expect(tool(handler, { ...base, visibility: 'silent' }).visibility).toBe(
      'silent',
    );
  });

  it('carries the declared effect through', () => {
    // The helper builds its result field by field, so an effect that is not
    // explicitly copied is silently dropped and the gate would classify the
    // tool as undeclared.
    const effect = { type: 'write', action: 'do_thing' } as const;
    expect(tool(handler, { ...base, effect }).effect).toEqual(effect);
  });

  it('carries effect resolvers, not just the action class', () => {
    const object = (args: unknown): string =>
      `ixo:oracle/treasury/${(args as { id: string }).id}`;
    const value = (): { amount: string; denom: string } => ({
      amount: '100',
      denom: 'uixo',
    });
    const built = tool(handler, {
      ...base,
      effect: { type: 'pay', action: 'release_payment', object, value },
    });
    expect(built.effect?.object).toBe(object);
    expect(built.effect?.value?.({})).toEqual({ amount: '100', denom: 'uixo' });
  });

  it('rejects a malformed descriptor', () => {
    expect(() => tool(handler, { ...base, name: '' })).toThrow(TypeError);
    expect(() => tool(handler, { ...base, description: '' })).toThrow(
      TypeError,
    );
    expect(() =>
      // @ts-expect-error — the runtime guard exists for callers without types.
      tool(handler, { name: 'x', description: 'y' }),
    ).toThrow(TypeError);
  });
});
