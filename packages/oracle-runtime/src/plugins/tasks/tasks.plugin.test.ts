import { describe, expect, it } from 'vitest';
import { validateManifest } from '../../manifest/validator.js';
import {
  buildSpec,
  parseSpec,
  renderSpec,
  specHash,
  TaskSpecFrontmatterSchema,
  userTasksPrefix,
  specPath,
  newTaskId,
} from './internal/domain/spec.js';
import { TriggerSchema, summarizeTrigger } from './internal/domain/trigger.js';
import { IntentClassifier } from './internal/approval/intent-classifier.js';
import { RoomResolver } from './internal/delivery/room-resolver.js';
import { TasksPlugin } from './tasks.plugin.js';

describe('TasksPlugin', () => {
  it('has the expected identity and manifest', () => {
    const plugin = new TasksPlugin();
    expect(plugin.name).toBe('tasks');
    expect(plugin.name).toBe(TasksPlugin.NAME);
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.manifest.title).toBe('Scheduled Tasks');
    expect(plugin.manifest.visibility).toBe('always');
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

  it('configSchema validates the documented env', () => {
    const plugin = new TasksPlugin();
    expect(plugin.configSchema!.safeParse({}).success).toBe(false);
    const ok = plugin.configSchema!.safeParse({
      REDIS_URL: 'redis://localhost:6379',
      TASKS_DEFAULT_TIMEZONE: 'Africa/Cairo',
      TASKS_MAX_PER_USER: '25',
      TASKS_RUN_LOCK_TTL_SEC: '300',
    });
    expect(ok.success).toBe(true);
  });

  it('exposes the 9 documented tools', () => {
    const plugin = new TasksPlugin();
    const tools = plugin.getTools!();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'cancel_task',
        'create_task',
        'get_task',
        'list_my_tasks',
        'pause_task',
        'preview_task',
        'resume_task',
        'suggest_spec_fix',
        'update_task',
      ].sort(),
    );
  });

  it('returns the TasksModule via getNestModules', () => {
    const plugin = new TasksPlugin();
    const modules = plugin.getNestModules!();
    expect(modules).toHaveLength(1);
    // DynamicModule
    expect(modules[0]).toMatchObject({ module: expect.any(Function) });
  });
});

describe('TaskSpec serialization', () => {
  it('round-trips markdown ↔ object via gray-matter', () => {
    const spec = buildSpec(
      {
        owner: 'did:ixo:abc',
        title: 'Morning Brief',
        trigger: { type: 'time.cron', pattern: '0 7 * * *', tz: 'UTC' },
        intent: {
          whatToDo: 'Summarise BTC ETH SOL',
          howToReport: 'One paragraph',
          constraints: ['Under 300 words.'],
        },
      },
      '2026-06-09T05:00:00.000Z',
    );
    const md = renderSpec(spec);
    expect(md).toContain('## What to do');
    expect(md).toContain('Summarise BTC ETH SOL');
    expect(md).toContain('Under 300 words');

    const parsed = parseSpec(md);
    expect(parsed.frontmatter.id).toBe(spec.frontmatter.id);
    expect(parsed.frontmatter.title).toBe('Morning Brief');
    expect(parsed.frontmatter.trigger).toEqual(spec.frontmatter.trigger);
    expect(parsed.body).toContain('Summarise BTC ETH SOL');
  });

  it('validates frontmatter via Zod and rejects bad cron / bad status', () => {
    expect(() =>
      TaskSpecFrontmatterSchema.parse({
        id: 'not-a-task-id',
        owner: 'did:ixo:abc',
        title: 'X',
        trigger: { type: 'time.cron', pattern: '0 7 * * *', tz: 'UTC' },
        delivery: { roomId: 'main', format: 'message' },
        approval: 'never',
        modelTier: 'medium',
        status: 'active',
        stats: { nextRunAt: null },
      }),
    ).toThrow();
  });

  it('builds canonical paths', () => {
    const did = 'did:ixo:abc';
    const id = 'task_aaaaaaaaaaaa';
    expect(userTasksPrefix(did)).toBe('/users/did:ixo:abc/tasks/');
    expect(specPath(did, id)).toBe(
      '/users/did:ixo:abc/tasks/task_aaaaaaaaaaaa/spec.md',
    );
  });

  it('newTaskId returns a canonical-shape id', () => {
    expect(newTaskId()).toMatch(/^task_[a-f0-9]{12}$/);
  });

  it('specHash is deterministic and changes with content', () => {
    const a = specHash({ title: 'X', body: 'body-1', modelTier: 'medium' });
    const b = specHash({ title: 'X', body: 'body-1', modelTier: 'medium' });
    const c = specHash({ title: 'X', body: 'body-2', modelTier: 'medium' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('Trigger schema + summary', () => {
  it('parses both trigger types', () => {
    expect(
      TriggerSchema.safeParse({
        type: 'time.once',
        runAtIso: '2026-06-09T07:00:00.000Z',
        tz: 'UTC',
      }).success,
    ).toBe(true);
    expect(
      TriggerSchema.safeParse({
        type: 'time.cron',
        pattern: '0 7 * * *',
        tz: 'UTC',
      }).success,
    ).toBe(true);
  });

  it('renders a human-readable summary', () => {
    expect(
      summarizeTrigger({
        type: 'time.cron',
        pattern: '0 7 * * *',
        tz: 'Africa/Cairo',
      }),
    ).toContain('cron');
    expect(
      summarizeTrigger({
        type: 'time.once',
        runAtIso: '2026-06-09T07:00:00.000Z',
        tz: 'UTC',
      }),
    ).toContain('once at');
  });
});

describe('IntentClassifier (fast path)', () => {
  const c = new IntentClassifier();

  it('matches obvious approvals', () => {
    expect(c.fastPath('yes')).toBe('approved');
    expect(c.fastPath('YES.')).toBe('approved');
    expect(c.fastPath('ok, do it')).toBe('approved');
  });

  it('matches obvious rejections', () => {
    expect(c.fastPath('no')).toBe('rejected');
    expect(c.fastPath('cancel.')).toBe('rejected');
    expect(c.fastPath('dont')).toBe('rejected');
  });

  it('returns "other" for free-form text', () => {
    expect(c.fastPath('something completely different')).toBe('other');
    expect(c.fastPath('actually can you change the schedule?')).toBe('other');
  });
});

describe('RoomResolver heuristic', () => {
  const r = new RoomResolver();

  it('forces a dedicated room when explicit=yes', () => {
    expect(
      r.shouldCreateDedicatedRoom({
        trigger: {
          type: 'time.once',
          runAtIso: '2099-01-01T00:00:00.000Z',
          tz: 'UTC',
        },
        intentBody: 'short',
        explicit: 'yes',
      }),
    ).toBe(true);
  });

  it('respects explicit=no', () => {
    expect(
      r.shouldCreateDedicatedRoom({
        trigger: { type: 'time.cron', pattern: '*/5 * * * *', tz: 'UTC' },
        intentBody: 'short',
        explicit: 'no',
      }),
    ).toBe(false);
  });

  it('auto-creates for sub-day cron', () => {
    expect(
      r.shouldCreateDedicatedRoom({
        trigger: { type: 'time.cron', pattern: '*/30 * * * *', tz: 'UTC' },
        intentBody: 'short',
        explicit: 'auto',
      }),
    ).toBe(true);
  });

  it('does not auto-create for daily cron', () => {
    expect(
      r.shouldCreateDedicatedRoom({
        trigger: { type: 'time.cron', pattern: '0 7 * * *', tz: 'UTC' },
        intentBody: 'short',
        explicit: 'auto',
      }),
    ).toBe(false);
  });

  it('auto-creates when intent mentions monitor / track', () => {
    expect(
      r.shouldCreateDedicatedRoom({
        trigger: {
          type: 'time.once',
          runAtIso: '2099-01-01T00:00:00.000Z',
          tz: 'UTC',
        },
        intentBody: 'Track the BTC price and report when it moves.',
        explicit: 'auto',
      }),
    ).toBe(true);
  });
});
