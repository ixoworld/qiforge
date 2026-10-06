import { describe, expect, it, vi } from 'vitest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { AGUIPlugin } from '../agui/agui.plugin';
import {
  MAX_DECLARED_DESCRIPTION_CHARS,
  MAX_DECLARED_SCHEMA_CHARS,
  MAX_DECLARED_TOOLS,
  sanitizeDeclaredTools,
} from './declared-tools';
import { PortalPlugin } from './portal.plugin';

const schema = { type: 'object', properties: {} };
const declared = (name: string, description = 'does a thing') => ({
  name,
  description,
  schema,
});

describe('sanitizeDeclaredTools', () => {
  it('drops invalid names, later duplicates, reserved names and oversized entries', () => {
    const { kept, dropped } = sanitizeDeclaredTools(
      [
        declared('open_url'),
        declared('open_url', 'second declaration'),
        declared('has space'),
        declared(''),
        declared('x'.repeat(65)),
        declared('read_flow'),
        declared('wordy', 'd'.repeat(MAX_DECLARED_DESCRIPTION_CHARS + 1)),
        {
          name: 'huge_schema',
          description: 'ok',
          schema: { blob: 'x'.repeat(MAX_DECLARED_SCHEMA_CHARS) },
        },
        declared('scroll-page'),
      ],
      new Set(['read_flow']),
    );
    expect(kept.map((t) => t.name)).toEqual(['open_url', 'scroll-page']);
    expect(kept[0]?.description).toBe('does a thing');
    expect(dropped.map((d) => d.reason)).toEqual([
      'duplicate name',
      'invalid name',
      'invalid name',
      'invalid name',
      'name taken by a server tool',
      `description over ${MAX_DECLARED_DESCRIPTION_CHARS} characters`,
      `schema over ${MAX_DECLARED_SCHEMA_CHARS} characters`,
    ]);
  });

  it(`keeps at most ${MAX_DECLARED_TOOLS} entries`, () => {
    const many = Array.from({ length: MAX_DECLARED_TOOLS + 5 }, (_, i) =>
      declared(`tool_${i}`),
    );
    expect(sanitizeDeclaredTools(many).kept).toHaveLength(MAX_DECLARED_TOOLS);
  });
});

describe('declared tools per request', () => {
  it('the Portal contributes one tool per valid, distinct browser tool', async () => {
    const ctx = makeRuntimeContext(
      {},
      {
        state: {
          browserTools: [
            declared('open_url'),
            declared('open_url'),
            declared('bad name'),
          ],
        },
      },
    );
    const tools = await new PortalPlugin().getRequestTools(ctx);
    expect(tools.map((t) => t.name)).toEqual(['open_url']);
  });

  it('AG-UI builds its sub-agent only from valid, distinct actions', async () => {
    const ctx = makeRuntimeContext(
      {},
      {
        state: {
          agActions: [
            declared('render_table'),
            declared('render_table'),
            declared('bad/name'),
          ],
        },
      },
    );
    const [subAgent] = await new AGUIPlugin().getRequestSubAgents(ctx);
    const names = (Array.isArray(subAgent?.tools) ? subAgent.tools : []).map(
      (t) => t.name,
    );
    expect(names).toEqual(['render_table']);
  });
});

describe('dropped declarations are logged once per request', () => {
  it.each(['portal', 'agui'] as const)(
    '%s writes one bounded warning for many dropped entries',
    async (plugin) => {
      const base = makeRuntimeContext(
        {},
        {
          state:
            plugin === 'portal'
              ? {
                  browserTools: Array.from({ length: 200 }, () =>
                    declared('bad name'),
                  ),
                }
              : {
                  agActions: Array.from({ length: 200 }, () =>
                    declared('bad name'),
                  ),
                },
        },
      );
      const warn = vi.fn();
      const ctx = { ...base, logger: { ...base.logger, warn } };
      if (plugin === 'portal') await new PortalPlugin().getRequestTools(ctx);
      else await new AGUIPlugin().getRequestSubAgents(ctx);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain('200');
      expect(line.length).toBeLessThan(1_000);
    },
  );
});
