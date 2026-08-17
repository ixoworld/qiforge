import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createValidatedHandler } from './use-ag-action.js';

describe('createValidatedHandler', () => {
  const parameters = z.object({
    title: z.string().optional(),
    rows: z.array(z.number()),
  });

  it('forwards schema-valid args to the handler and returns its result', async () => {
    const handler = vi.fn(({ rows }: { rows: number[] }) => rows.length);

    const validated = createValidatedHandler({
      name: 'create_data_table',
      description: 'Create a table',
      parameters,
      handler,
    });

    // A sync handler's value passes straight through, unwrapped.
    expect(validated({ title: 'Q3', rows: [1, 2, 3] })).toBe(3);
    expect(handler).toHaveBeenCalledWith({ title: 'Q3', rows: [1, 2, 3] });
  });

  it('strips keys the schema does not declare', async () => {
    const handler = vi.fn(() => null);

    const validated = createValidatedHandler({
      name: 'create_data_table',
      description: 'Create a table',
      parameters,
      handler,
    });

    await validated({
      rows: [1],
      hallucinatedField: 'should not reach handler',
    });

    expect(handler).toHaveBeenCalledWith({ rows: [1] });
  });

  it('throws without invoking the handler when args violate the schema', async () => {
    const handler = vi.fn(() => null);

    const validated = createValidatedHandler({
      name: 'create_data_table',
      description: 'Create a table',
      parameters,
      handler,
    });

    // `rows` is required and must be numbers; the oracle sent neither.
    expect(() => validated({ rows: 'not-an-array' })).toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});
