/**
 * Task spec markdown — gray-matter frontmatter round-trip and id minting.
 */
import { describe, expect, it } from 'vitest';
import type { OracleTaskRecord } from '../plugin-api/types';
import {
  newTaskId,
  parseTaskSpec,
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

  it('rejects a spec whose frontmatter drifted from the schema', () => {
    expect(() => parseTaskSpec('---\nid: nonsense\n---\nbody')).toThrow();
  });
});
