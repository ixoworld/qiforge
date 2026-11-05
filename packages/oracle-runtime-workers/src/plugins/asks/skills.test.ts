import { describe, expect, it } from 'vitest';
import type { DecisionEvaluation, RuntimeContext } from '../../plugin-api';
import {
  asksSkillDecisionOptions,
  lastHumanText,
  NO_SKILL,
  pickSkill,
  type AsksSkillDecision,
} from './skill-pick';
import {
  AsksSkills,
  bundledSnapshot,
  descriptionOf,
  folderOf,
  SKILLS_RETRY_MS,
  SKILLS_TTL_MS,
  type SkillCache,
  type SkillFolder,
  type SkillSnapshot,
} from './skills';
import { recordingFetch } from './testing';

const skillText = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

/** GitHub: a listing of `names`, each SKILL.md with an ETag; If-None-Match on a known ETag gets a 304. */
function github(names: string[], down = false) {
  return recordingFetch((call) => {
    if (down) throw new Error('getaddrinfo ENOTFOUND');
    const sent = new Headers(call.init?.headers).get('if-none-match');
    if (call.url.startsWith('https://api.github.com/')) {
      if (sent === '"list-1"') return new Response(null, { status: 304 });
      return new Response(
        JSON.stringify(names.map((name) => ({ name, type: 'dir' }))),
        { headers: { etag: '"list-1"' } },
      );
    }
    const name = /skills\/([^/]+)\/SKILL\.md$/.exec(call.url)?.[1] ?? '';
    if (sent === `"${name}-1"`) return new Response(null, { status: 304 });
    return new Response(skillText(name, `Fresh ${name}.`), {
      headers: { etag: `"${name}-1"` },
    });
  });
}

class MemoryCache implements SkillCache {
  readonly kept = new Map<SkillFolder, SkillSnapshot>();

  read(folder: SkillFolder) {
    return Promise.resolve(this.kept.get(folder));
  }

  write(folder: SkillFolder, snapshot: SkillSnapshot) {
    this.kept.set(folder, structuredClone(snapshot));
    return Promise.resolve();
  }
}

function loader(
  fetcher: typeof fetch,
  clock: { now: number },
  cache?: SkillCache,
  folder: SkillFolder = 'asks-testnet',
) {
  return new AsksSkills({
    folder,
    fetch: fetcher,
    now: () => clock.now,
    ...(cache ? { cache } : {}),
  });
}

/** Run `skills()` and wait for the refresh it starts. */
async function skillsNow(skills: AsksSkills) {
  const work: Array<Promise<unknown>> = [];
  const list = await skills.skills((one) => work.push(one));
  await Promise.all(work);
  return { list, refreshed: work.length > 0 };
}

describe('asks skills', () => {
  it('reads the folder of the network: asks on mainnet, asks-testnet on testnet and devnet', async () => {
    expect([
      folderOf('mainnet'),
      folderOf('testnet'),
      folderOf('devnet'),
    ]).toEqual(['asks', 'asks-testnet', 'asks-testnet']);
    for (const folder of ['asks', 'asks-testnet'] as const) {
      const net = github(['jobs']);
      await skillsNow(loader(net.fetcher, { now: 0 }, undefined, folder));
      expect(net.calls[0]!.url).toBe(
        `https://api.github.com/repos/ixoworld/ixo-plugins/contents/plugins/${folder}/skills?ref=main`,
      );
      expect(net.calls[1]!.url).toBe(
        `https://raw.githubusercontent.com/ixoworld/ixo-plugins/main/plugins/${folder}/skills/jobs/SKILL.md`,
      );
    }
  });

  it('miss: answers from the bundled copy at once, then has the fresh skills (names from the folder)', async () => {
    const net = github(['jobs', 'brand-new']);
    const cache = new MemoryCache();
    const skills = loader(net.fetcher, { now: 0 }, cache);
    const first = await skillsNow(skills);
    expect(first.list.map((one) => one.name)).toEqual(
      Object.keys(bundledSnapshot('asks-testnet').files).sort(),
    );
    expect(first.refreshed).toBe(true);
    const second = await skillsNow(skills);
    expect(second.list.map((one) => one.name)).toEqual(['brand-new', 'jobs']);
    expect(second.list[0]!.description).toBe('Fresh brand-new.');
    expect(second.refreshed).toBe(false);
    expect(cache.kept.get('asks-testnet')!.files.jobs!.etag).toBe('"jobs-1"');
  });

  it('hit: within the hour no request goes to GitHub, and a new isolate starts from the cache', async () => {
    const clock = { now: 0 };
    const cache = new MemoryCache();
    const net = github(['jobs']);
    await skillsNow(loader(net.fetcher, clock, cache));
    const calls = net.calls.length;
    clock.now = SKILLS_TTL_MS - 1;
    const restarted = loader(net.fetcher, clock, cache);
    const again = await skillsNow(restarted);
    expect(again.list.map((one) => one.name)).toEqual(['jobs']);
    expect(again.refreshed).toBe(false);
    expect(net.calls.length).toBe(calls);
  });

  it('expiry: after an hour it refreshes with If-None-Match, and a 304 keeps the copy', async () => {
    const clock = { now: 0 };
    const net = github(['jobs']);
    const skills = loader(net.fetcher, clock);
    await skillsNow(skills);
    clock.now = SKILLS_TTL_MS;
    const before = net.calls.length;
    const { list, refreshed } = await skillsNow(skills);
    expect(refreshed).toBe(true);
    const sent = net.calls
      .slice(before)
      .map((call) => new Headers(call.init?.headers).get('if-none-match'));
    expect(sent).toEqual(['"list-1"', '"jobs-1"']);
    expect(list.map((one) => one.description)).toEqual(['Fresh jobs.']);
    // The 304s count as a refresh: fresh again for an hour.
    expect((await skillsNow(skills)).refreshed).toBe(false);
  });

  it('GitHub down: the bundled copy, no thrown error, and no retry for a while', async () => {
    const clock = { now: 0 };
    const net = github([], true);
    const skills = loader(net.fetcher, clock);
    const { list } = await skillsNow(skills);
    expect(list.length).toBeGreaterThan(0);
    expect(list.find((one) => one.name === 'jobs')!.text).toContain(
      'name: jobs',
    );
    const calls = net.calls.length;
    clock.now = SKILLS_RETRY_MS - 1;
    expect((await skillsNow(skills)).refreshed).toBe(false);
    clock.now = SKILLS_RETRY_MS;
    expect((await skillsNow(skills)).refreshed).toBe(true);
    expect(net.calls.length).toBeGreaterThan(calls);
  });

  it('reads the one-line description from the frontmatter', () => {
    expect(
      descriptionOf(skillText('jobs', 'Find paid work. Use when "jobs".')),
    ).toBe('Find paid work. Use when "jobs".');
    expect(descriptionOf('no frontmatter')).toBe('');
  });
});

describe('the skill decision', () => {
  const skills = [
    { name: 'jobs', description: 'Find paid work.', text: '# jobs' },
    { name: 'create', description: 'Post an ask.', text: '# create' },
  ];
  const definition = asksSkillDecisionOptions as unknown as AsksSkillDecision;
  const answering = (value: string, confidence: number) =>
    ({
      evaluate: (_definition: unknown, input: unknown) => {
        expect(input).toEqual({
          text: 'find me paid work',
          skills: [
            { name: 'jobs', description: 'Find paid work.' },
            { name: 'create', description: 'Post an ask.' },
          ],
        });
        return Promise.resolve({
          answers: {
            skill: { kind: 'choice', value, confidence, probabilities: {} },
          },
        } as unknown as DecisionEvaluation);
      },
    }) as unknown as RuntimeContext['decisions'];

  it('offers every skill and "none" to the model', () => {
    const projected = asksSkillDecisionOptions.project({ text: 'x', skills });
    expect(
      Object.keys(
        (projected.questions.skill as { options: Record<string, string> })
          .options,
      ),
    ).toEqual(['jobs', 'create', NO_SKILL]);
  });

  it('picks the skill the message needs', async () => {
    expect(
      (
        await pickSkill(
          answering('jobs', 0.9),
          definition,
          'find me paid work',
          skills,
        )
      )?.name,
    ).toBe('jobs');
  });

  it('fails open: none, low confidence, an error', async () => {
    expect(
      await pickSkill(
        answering(NO_SKILL, 0.95),
        definition,
        'find me paid work',
        skills,
      ),
    ).toBeNull();
    expect(
      await pickSkill(
        answering('jobs', 0.3),
        definition,
        'find me paid work',
        skills,
      ),
    ).toBeNull();
    const broken = {
      evaluate: () => Promise.reject(new Error('timeout')),
    } as unknown as RuntimeContext['decisions'];
    expect(
      await pickSkill(broken, definition, 'find me paid work', skills),
    ).toBeNull();
    expect(await pickSkill(broken, definition, '', skills)).toBeNull();
  });

  it("reads the person's last message", () => {
    expect(
      lastHumanText([
        { type: 'human', content: 'first' },
        { type: 'ai', content: 'x' },
        { type: 'human', content: [{ type: 'text', text: 'last' }] },
      ]),
    ).toBe('last');
  });
});
