/**
 * Consumer-facing check of the `@ixo/common/work` subpath: it resolves the
 * package `exports` map (self-reference), so it runs against the built
 * `dist/work` output. Run `pnpm --filter @ixo/common build` first.
 */
import { describe, expect, it } from 'vitest';
import {
  AgentWakeSchema,
  PORTABLE_WORK_RESERVED_CONFIGURATION_KEYS,
  PortableWorkDefinitionSchema,
  agentWakeDedupeKey,
} from '@ixo/common/work';

describe('@ixo/common/work subpath', () => {
  it('exposes the working contracts', () => {
    expect(
      PortableWorkDefinitionSchema.safeParse({
        version: 1,
        title: 'T',
        intent: 'I',
      }).success,
    ).toBe(true);
    expect(
      PortableWorkDefinitionSchema.safeParse({
        version: 1,
        title: 'T',
        intent: 'I',
        configurationDefaults: { secret: 'x' },
      }).success,
    ).toBe(false);
    expect(PORTABLE_WORK_RESERVED_CONFIGURATION_KEYS).toContain('ucan');
    const wake = AgentWakeSchema.parse({
      version: 1,
      wakeId: 'w1',
      principal: 'did:ixo:alice',
      source: 'task',
      resourceRef: 'task:t',
      reason: 'scheduled-run',
      occurredAt: '2026-09-30T07:00:00.000Z',
      notifyOnly: true,
    });
    expect(agentWakeDedupeKey(wake)).toBe('did:ixo:alice\u0000w1');
  });
});
