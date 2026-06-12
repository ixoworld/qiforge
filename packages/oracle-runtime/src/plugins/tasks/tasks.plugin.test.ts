import { describe, expect, it } from 'vitest';
import { validateManifest } from '../../manifest/validator.js';
import { shouldCreateDedicatedRoom } from './internal/delivery.js';
import { nextRunAtFor, runJobId } from './internal/scheduler.js';
import {
  newTaskId,
  parseSpec,
  renderSpec,
  specHash,
  specPath,
  TaskFrontmatterSchema,
  userTasksPrefix,
  type TaskSpec,
} from './internal/spec.js';
import type { TaskFs } from './internal/task-fs.js';
import { TaskStore } from './internal/task-store.js';
import { TasksPlugin } from './tasks.plugin.js';

const sampleSpec = (): TaskSpec => ({
  frontmatter: {
    id: 'task_morning-brief_a1b2c3d4',
    owner: 'did:ixo:abc',
    title: 'Morning Brief',
    trigger: { type: 'time.cron', pattern: '0 7 * * *', tz: 'Africa/Cairo' },
    delivery: { roomId: 'main' },
    approval: 'never',
    status: 'active',
    stats: { nextRunAt: '2026-06-11T05:00:00.000Z' },
  },
  body: '## What to do\nSummarise BTC, ETH, SOL.\n\n## Constraints\n- Under 300 words.',
});

class MemoryFs implements TaskFs {
  private files = new Map<string, string>();

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((p) => p.startsWith(prefix));
  }
}

describe('TasksPlugin', () => {
  it('has the expected identity and a valid manifest', () => {
    const plugin = new TasksPlugin();
    expect(plugin.name).toBe('tasks');
    expect(plugin.version).toBe('2.0.0');
    expect(plugin.manifest.visibility).toBe('on-demand');
    expect(plugin.manifest.category).toBe('automation');
    expect(plugin.softDependsOn).toEqual(['memory']);

    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('auto-detects only when REDIS_URL is present', () => {
    const plugin = new TasksPlugin();
    expect(plugin.autoDetect?.({})).toBe(false);
    expect(plugin.autoDetect?.({ REDIS_URL: '' })).toBe(false);
    expect(plugin.autoDetect?.({ REDIS_URL: 'redis://localhost:6379' })).toBe(
      true,
    );
    expect(plugin.autoDetectHint).toBe('REDIS_URL');
  });

  it('configSchema requires REDIS_URL and coerces the numeric knobs', () => {
    const plugin = new TasksPlugin();
    expect(plugin.configSchema!.safeParse({}).success).toBe(false);
    const parsed = plugin.configSchema!.parse({
      REDIS_URL: 'redis://localhost:6379',
      TASKS_MAX_PER_USER: '25',
    });
    expect(parsed.TASKS_MAX_PER_USER).toBe(25);
    expect(parsed.TASKS_RUN_LOCK_TTL_SEC).toBe(600);
    expect(parsed.TASKS_MIN_CRON_INTERVAL_SEC).toBe(300);
  });

  it('exposes the 9 documented tools', () => {
    const tools = new TasksPlugin().getTools!();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'cancel_task',
      'create_task',
      'get_task',
      'list_my_tasks',
      'pause_task',
      'preview_task',
      'resume_task',
      'suggest_spec_fix',
      'update_task',
    ]);
  });

  it('tool handlers fail soft before the Nest module attaches the runtime', async () => {
    const tools = new TasksPlugin().getTools!();
    const list = tools.find((t) => t.name === 'list_my_tasks')!;
    await expect(
      list.handler({}, { user: { did: 'did:ixo:abc' } } as never),
    ).rejects.toThrow(/starting up/);
  });

  it('registers the TasksModule dynamically', () => {
    const modules = new TasksPlugin().getNestModules!();
    expect(modules).toHaveLength(1);
    expect(modules[0]).toMatchObject({ module: expect.any(Function) });
  });
});

describe('TaskSpec', () => {
  it('round-trips markdown ↔ object', () => {
    const spec = sampleSpec();
    const markdown = renderSpec(spec);
    expect(markdown).toContain('## What to do');
    expect(markdown).toContain('title: Morning Brief');

    const parsed = parseSpec(markdown);
    expect(parsed.frontmatter).toEqual(spec.frontmatter);
    expect(parsed.body).toBe(spec.body);
  });

  it('rejects malformed frontmatter', () => {
    expect(() =>
      TaskFrontmatterSchema.parse({
        ...sampleSpec().frontmatter,
        id: 'not-a-task-id',
      }),
    ).toThrow();
    expect(() =>
      TaskFrontmatterSchema.parse({
        ...sampleSpec().frontmatter,
        status: 'draft',
      }),
    ).toThrow();
  });

  it('accepts the before-action approval mode and rejects the old before-delivery', () => {
    expect(
      TaskFrontmatterSchema.parse({
        ...sampleSpec().frontmatter,
        approval: 'before-action',
      }).approval,
    ).toBe('before-action');
    expect(() =>
      TaskFrontmatterSchema.parse({
        ...sampleSpec().frontmatter,
        approval: 'before-delivery',
      }),
    ).toThrow();
  });

  it('builds canonical ids and paths', () => {
    expect(newTaskId('Morning Brief')).toMatch(
      /^task_morning-brief_[a-f0-9]{8}$/,
    );
    expect(newTaskId('  Watch BTC!! (hourly)  ')).toMatch(
      /^task_watch-btc-hourly_[a-f0-9]{8}$/,
    );
    expect(newTaskId('!!!')).toMatch(/^task_untitled_[a-f0-9]{8}$/);

    const longId = newTaskId(
      'A very long title that keeps going well past the slug budget',
    );
    const slug = longId.slice('task_'.length, longId.lastIndexOf('_'));
    expect(slug.length).toBeLessThanOrEqual(24);
    expect(longId).not.toContain(':');

    expect(userTasksPrefix('did:ixo:abc')).toBe('/users/did:ixo:abc/tasks/');
    expect(specPath('did:ixo:abc', 'task_demo_aaaaaaaa')).toBe(
      '/users/did:ixo:abc/tasks/task_demo_aaaaaaaa/spec.md',
    );
  });

  it('specHash is deterministic and content-sensitive', () => {
    expect(specHash('T', 'body')).toBe(specHash('T', 'body'));
    expect(specHash('T', 'body')).not.toBe(specHash('T', 'other'));
  });
});

describe('TaskStore', () => {
  it('saves, loads, lists, and transitions status through the TaskFs port', async () => {
    const store = new TaskStore(new MemoryFs());
    const spec = sampleSpec();

    await store.save(spec);
    expect(await store.load('did:ixo:abc', spec.frontmatter.id)).toEqual(spec);
    expect(await store.load('did:ixo:abc', 'task_missing_00000000')).toBeNull();
    expect(await store.list('did:ixo:abc')).toHaveLength(1);
    expect(await store.list('did:ixo:other')).toHaveLength(0);

    const paused = await store.setStatus(
      'did:ixo:abc',
      spec.frontmatter.id,
      'paused',
      null,
    );
    expect(paused?.frontmatter.status).toBe('paused');
    expect(paused?.frontmatter.stats.nextRunAt).toBeNull();
  });

  it('skips unparseable specs when listing', async () => {
    const fs = new MemoryFs();
    const store = new TaskStore(fs);
    await store.save(sampleSpec());
    await fs.write('/users/did:ixo:abc/tasks/task_bad/spec.md', 'not a spec');
    expect(await store.list('did:ixo:abc')).toHaveLength(1);
  });

  it('setStatus with onlyIfStatus refuses to clobber another status', async () => {
    const store = new TaskStore(new MemoryFs());
    const spec = sampleSpec();
    await store.save(spec);
    await store.setStatus('did:ixo:abc', spec.frontmatter.id, 'paused', null);

    const result = await store.setStatus(
      'did:ixo:abc',
      spec.frontmatter.id,
      'completed',
      null,
      { onlyIfStatus: ['active'] },
    );
    expect(result).toBeNull();
    const reloaded = await store.load('did:ixo:abc', spec.frontmatter.id);
    expect(reloaded?.frontmatter.status).toBe('paused');
  });

  it('updateNextRun only touches nextRunAt and only while active', async () => {
    const store = new TaskStore(new MemoryFs());
    const spec = sampleSpec();
    await store.save(spec);

    const updated = await store.updateNextRun(
      'did:ixo:abc',
      spec.frontmatter.id,
      '2026-07-01T00:00:00.000Z',
    );
    expect(updated?.frontmatter.status).toBe('active');
    expect(updated?.frontmatter.stats.nextRunAt).toBe(
      '2026-07-01T00:00:00.000Z',
    );

    await store.setStatus('did:ixo:abc', spec.frontmatter.id, 'paused', null);
    expect(
      await store.updateNextRun(
        'did:ixo:abc',
        spec.frontmatter.id,
        '2026-08-01T00:00:00.000Z',
      ),
    ).toBeNull();
    const reloaded = await store.load('did:ixo:abc', spec.frontmatter.id);
    expect(reloaded?.frontmatter.stats.nextRunAt).toBeNull();
  });
});

describe('nextRunAtFor', () => {
  it('returns the future time for a one-shot, null when past', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(
      nextRunAtFor({ type: 'time.once', runAtIso: future, tz: 'UTC' }),
    ).toBe(future);
    expect(
      nextRunAtFor({
        type: 'time.once',
        runAtIso: '2020-01-01T00:00:00.000Z',
        tz: 'UTC',
      }),
    ).toBeNull();
  });

  it('computes the next cron occurrence and rejects bad patterns', () => {
    const from = new Date('2026-06-10T12:00:00.000Z');
    expect(
      nextRunAtFor(
        { type: 'time.cron', pattern: '0 7 * * *', tz: 'UTC' },
        from,
      ),
    ).toBe('2026-06-11T07:00:00.000Z');
    expect(
      nextRunAtFor(
        { type: 'time.cron', pattern: 'not a cron', tz: 'UTC' },
        from,
      ),
    ).toBeNull();
  });
});

describe('runJobId', () => {
  it('contains no colons (BullMQ rejects them in custom job ids)', () => {
    const id = runJobId(
      'task_morning-brief_a1b2c3d4',
      '2026-06-11T05:00:00.000Z',
    );
    expect(id).not.toContain(':');
    expect(id).toBe('task_morning-brief_a1b2c3d4@2026-06-11T05.00.00.000Z');
  });
});

describe('shouldCreateDedicatedRoom', () => {
  const onceTrigger = {
    type: 'time.once',
    runAtIso: '2099-01-01T00:00:00.000Z',
    tz: 'UTC',
  } as const;

  it('honours explicit yes/no over the heuristic', () => {
    expect(
      shouldCreateDedicatedRoom({
        trigger: onceTrigger,
        intentBody: 'x',
        explicit: 'yes',
      }),
    ).toBe(true);
    expect(
      shouldCreateDedicatedRoom({
        trigger: { type: 'time.cron', pattern: '*/5 * * * *', tz: 'UTC' },
        intentBody: 'x',
        explicit: 'no',
      }),
    ).toBe(false);
  });

  it('auto-creates for sub-day cron but not daily', () => {
    expect(
      shouldCreateDedicatedRoom({
        trigger: { type: 'time.cron', pattern: '*/30 * * * *', tz: 'UTC' },
        intentBody: 'x',
        explicit: 'auto',
      }),
    ).toBe(true);
    expect(
      shouldCreateDedicatedRoom({
        trigger: { type: 'time.cron', pattern: '0 7 * * *', tz: 'UTC' },
        intentBody: 'x',
        explicit: 'auto',
      }),
    ).toBe(false);
  });

  it('auto-creates for monitoring-style intents', () => {
    expect(
      shouldCreateDedicatedRoom({
        trigger: onceTrigger,
        intentBody: 'Track the BTC price and report when it moves.',
        explicit: 'auto',
      }),
    ).toBe(true);
  });
});
