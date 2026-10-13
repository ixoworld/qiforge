/**
 * Task spec markdown — gray-matter frontmatter round-trip and id minting.
 */
import { agentWakeDedupeKey } from '@ixo/common/work';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import type { OracleTaskRecord } from '../plugin-api/types';
import {
  agentWakeFromTaskRecord,
  newTaskId,
  parseTaskSpec,
  portableWorkFromTaskRecord,
  renderTaskSpec,
  specIntentOf,
  TASK_ID_PATTERN,
} from './spec';

function record(overrides: Partial<OracleTaskRecord> = {}): OracleTaskRecord {
  return {
    id: 'task_morning-brief_0a1b2c3d',
    title: 'Morning Brief',
    intent:
      '## What to do\nSummarize the news.\n\n## Constraints\n- Under 300 words.',
    schedule: { kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' },
    status: 'active',
    approval: 'never',
    createdAt: '2026-01-15T06:00:00.000Z',
    updatedAt: '2026-01-15T06:00:00.000Z',
    consecutiveFailures: 0,
    ...overrides,
  };
}

describe('newTaskId', () => {
  it('mints slugged ids matching the task id pattern', () => {
    const id = newTaskId('Morning Crypto Brief!');
    expect(id).toMatch(TASK_ID_PATTERN);
    expect(id.startsWith('task_morning-crypto-brief_')).toBe(true);
  });

  it('falls back to "untitled" for degenerate titles', () => {
    expect(newTaskId('!!!')).toMatch(/^task_untitled_[a-f0-9]{8}$/);
  });
});

describe('task spec markdown', () => {
  it('round-trips frontmatter and intent through gray-matter', () => {
    const original = record();
    const markdown = renderTaskSpec(original);
    expect(markdown.startsWith('---\n')).toBe(true);

    const parsed = parseTaskSpec(markdown);
    expect(parsed.frontmatter.id).toBe(original.id);
    expect(parsed.frontmatter.title).toBe(original.title);
    expect(parsed.frontmatter.schedule).toEqual(original.schedule);
    expect(parsed.frontmatter.approval).toBe(original.approval);
    expect(parsed.frontmatter.status).toBe(original.status);
    expect(parsed.frontmatter.createdAt).toBe(original.createdAt);
    expect(parsed.intent).toBe(original.intent);
    expect(specIntentOf(markdown)).toBe(original.intent);
  });

  it('serialises a once schedule (no undefined YAML values)', () => {
    const markdown = renderTaskSpec(
      record({
        schedule: { kind: 'once', at: '2026-02-01T09:00:00.000Z' },
        approval: 'before-action',
        status: 'paused',
      }),
    );
    const parsed = parseTaskSpec(markdown);
    expect(parsed.frontmatter.schedule).toEqual({
      kind: 'once',
      at: '2026-02-01T09:00:00.000Z',
    });
    expect(parsed.frontmatter.approval).toBe('before-action');
    expect(parsed.frontmatter.status).toBe('paused');
  });

  it('leaves gray-matter’s module-wide content cache untouched', () => {
    // gray-matter caches every distinct input string forever when it is
    // called without options; every task save renders a new spec, so a
    // cached parse per save would grow the isolate's heap without bound.
    const cacheSize = (): number => {
      const cache: unknown = Reflect.get(matter, 'cache');
      return cache !== null && typeof cache === 'object'
        ? Object.keys(cache).length
        : 0;
    };
    const before = cacheSize();
    for (let i = 0; i < 25; i += 1) {
      const markdown = renderTaskSpec(
        record({
          intent: `Distinct intent ${i}`,
          updatedAt: new Date(Date.UTC(2026, 0, 15, 6, i)).toISOString(),
        }),
      );
      expect(parseTaskSpec(markdown).intent).toBe(`Distinct intent ${i}`);
      expect(specIntentOf(markdown)).toBe(`Distinct intent ${i}`);
    }
    expect(cacheSize()).toBe(before);
  });

  it('rejects a spec whose frontmatter drifted from the schema', () => {
    expect(() => parseTaskSpec('---\nid: nonsense\n---\nbody')).toThrow();
  });

  it('exports definition-only portable work', () => {
    const portable = portableWorkFromTaskRecord(record());
    expect(portable).toEqual({
      version: 1,
      title: 'Morning Brief',
      intent:
        '## What to do\nSummarize the news.\n\n## Constraints\n- Under 300 words.',
    });
    expect(portable).not.toHaveProperty('schedule');
    expect(portable).not.toHaveProperty('approval');
    expect(portable).not.toHaveProperty('status');
  });

  it('creates stable notify-only task wakes without copying work content', () => {
    const at = '2026-01-15T07:00:00.000Z';
    const wake = agentWakeFromTaskRecord(record(), 'did:ixo:alice', at);
    expect(agentWakeFromTaskRecord(record(), 'did:ixo:alice', at)).toEqual(
      wake,
    );
    expect(wake).toMatchObject({
      principal: 'did:ixo:alice',
      source: 'task',
      resourceRef: 'task:task_morning-brief_0a1b2c3d',
      observedRevision: '2026-01-15T06:00:00.000Z',
      evaluatedThrough: at,
      notifyOnly: true,
    });
    expect(wake).not.toHaveProperty('intent');
    expect(wake).not.toHaveProperty('approval');
  });

  it('derives the wake dedupe key from principal and wake id', () => {
    const at = '2026-01-15T07:00:00.000Z';
    const wake = agentWakeFromTaskRecord(record(), 'did:ixo:alice', at);
    expect(agentWakeDedupeKey(wake)).toBe(
      `did:ixo:alice\u0000task:task_morning-brief_0a1b2c3d@${at}`,
    );
    expect(
      agentWakeDedupeKey(
        agentWakeFromTaskRecord(record(), 'did:ixo:alice', at),
      ),
    ).toBe(agentWakeDedupeKey(wake));
  });

  it('refuses to emit a malformed wake', () => {
    const at = '2026-01-15T07:00:00.000Z';
    expect(() => agentWakeFromTaskRecord(record(), 'alice', at)).toThrow();
    expect(() =>
      agentWakeFromTaskRecord(record(), 'did:ixo:alice', 'tomorrow'),
    ).toThrow();
  });

  it('refuses to export portable work without a title or intent', () => {
    expect(() => portableWorkFromTaskRecord(record({ title: '' }))).toThrow();
    expect(() => portableWorkFromTaskRecord(record({ intent: '' }))).toThrow();
  });
});
