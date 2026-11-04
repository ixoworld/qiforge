/**
 * The asks skills, read at runtime from the released ixo-plugins repo so a
 * newly published skill needs no oracle release: mainnet reads
 * `plugins/asks/skills/<name>/SKILL.md`, testnet and devnet
 * `plugins/asks-testnet/...` (practice money). The names come from the
 * folder listing.
 *
 * Never on a turn's path: `skills()` answers from memory, then the Workers
 * cache (across isolate restarts), then the bundled copy, and refreshes in
 * the background once the copy is an hour old, with `If-None-Match` so an
 * unchanged file costs a 304 (which GitHub does not count against its rate
 * limit). Any failure keeps what is there.
 *
 * The bundled copy (`skills.bundled.json`) was taken from ixo-plugins `main`;
 * refresh it by re-reading the same two folders when the skills change a lot.
 */
import bundled from './skills.bundled.json';

export const SKILLS_TTL_MS = 60 * 60_000;
/** After a failed refresh, wait this long before trying GitHub again. */
export const SKILLS_RETRY_MS = 5 * 60_000;

const REPO = 'ixoworld/ixo-plugins';
const BRANCH = 'main';
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A skill can be preloaded into a turn's system prompt: keep it bounded. */
export const MAX_SKILL_CHARS = 16_000;
export const MAX_SKILLS = 30;

export type SkillFolder = 'asks' | 'asks-testnet';

export const folderOf = (network: unknown): SkillFolder =>
  network === 'mainnet' ? 'asks' : 'asks-testnet';

export interface Skill {
  name: string;
  /** The frontmatter's one-line `description`. */
  description: string;
  /** The whole SKILL.md. */
  text: string;
}

export interface SkillSnapshot {
  fetchedAt: number;
  listEtag?: string;
  files: Record<string, { text: string; etag?: string }>;
}

/** Storage that outlives the isolate. */
export interface SkillCache {
  read(folder: SkillFolder): Promise<SkillSnapshot | undefined>;
  write(folder: SkillFolder, snapshot: SkillSnapshot): Promise<void>;
}

export function descriptionOf(text: string): string {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const line = /^description:\s*(.+)$/m.exec(front)?.[1] ?? '';
  return line.trim().replace(/^(["'])(.*)\1$/, '$2');
}

export function bundledSnapshot(folder: SkillFolder): SkillSnapshot {
  const files = bundled[folder];
  return {
    fetchedAt: 0,
    files: Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, { text }]),
    ),
  };
}

/** The Workers cache (per data centre); absent outside Workers. */
export function workersSkillCache(): SkillCache | undefined {
  const storage = (globalThis as { caches?: { default?: Cache } }).caches;
  const cache = storage?.default;
  if (!cache) return undefined;
  const key = (folder: SkillFolder) =>
    new Request(`https://asks-skills.oracle.invalid/${folder}`);
  return {
    read: async (folder) => {
      const hit = await cache.match(key(folder));
      return hit ? await hit.json<SkillSnapshot>() : undefined;
    },
    write: (folder, snapshot) =>
      cache.put(
        key(folder),
        new Response(JSON.stringify(snapshot), {
          headers: {
            'content-type': 'application/json',
            'cache-control': 'max-age=604800',
          },
        }),
      ),
  };
}

export interface AsksSkillsDeps {
  folder: SkillFolder;
  fetch: typeof fetch;
  now: () => number;
  cache?: SkillCache;
  warn?: (line: string) => void;
}

export class AsksSkills {
  private snapshot: SkillSnapshot | null = null;

  private cacheRead: Promise<void> | null = null;

  private refreshing: Promise<void> | null = null;

  private retryAt = 0;

  constructor(private readonly deps: AsksSkillsDeps) {}

  /** The skills as known now. Starts a background refresh when they are an hour old. */
  async skills(
    background?: (work: Promise<unknown>) => void,
  ): Promise<Skill[]> {
    this.cacheRead ??= (async () => {
      const kept = await this.deps.cache
        ?.read(this.deps.folder)
        .catch(() => undefined);
      if (kept && !this.snapshot) this.snapshot = kept;
    })();
    await this.cacheRead;
    const now = this.deps.now();
    const fresh =
      this.snapshot && now - this.snapshot.fetchedAt < SKILLS_TTL_MS;
    if (!fresh && now >= this.retryAt) {
      const work = this.refresh();
      if (background) background(work);
    }
    const files = (this.snapshot ?? bundledSnapshot(this.deps.folder)).files;
    return Object.entries(files)
      .map(([name, { text }]) => ({
        name,
        description: descriptionOf(text),
        text,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Single-flight; never rejects. */
  refresh(): Promise<void> {
    this.refreshing ??= this.pull()
      .catch((error: unknown) => {
        this.retryAt = this.deps.now() + SKILLS_RETRY_MS;
        this.deps.warn?.(
          `[asks] skills refresh failed, keeping the current copy: ${String(error)}`,
        );
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private async pull(): Promise<void> {
    const { folder } = this.deps;
    const before = this.snapshot ?? bundledSnapshot(folder);
    const list = await this.deps.fetch(
      `https://api.github.com/repos/${REPO}/contents/plugins/${folder}/skills?ref=${BRANCH}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'ixo-oracle',
          ...(before.listEtag ? { 'if-none-match': before.listEtag } : {}),
        },
      },
    );
    let names: string[];
    if (list.status === 304) names = Object.keys(before.files);
    else if (list.ok) {
      const entries =
        await list.json<Array<{ name?: unknown; type?: unknown }>>();
      names = entries.flatMap((one) =>
        one.type === 'dir' && typeof one.name === 'string' ? [one.name] : [],
      );
    } else throw new Error(`listing answered ${list.status}`);
    names = names.filter((name) => SKILL_NAME.test(name)).slice(0, MAX_SKILLS);

    const files: SkillSnapshot['files'] = {};
    await Promise.all(
      names.map(async (name) => {
        const kept = before.files[name];
        const response = await this.deps.fetch(
          `https://raw.githubusercontent.com/${REPO}/${BRANCH}/plugins/${folder}/skills/${name}/SKILL.md`,
          { headers: kept?.etag ? { 'if-none-match': kept.etag } : {} },
        );
        if (response.status === 304 && kept) files[name] = kept;
        else if (response.ok)
          files[name] = {
            text: (await response.text()).slice(0, MAX_SKILL_CHARS),
            etag: response.headers.get('etag') ?? undefined,
          };
        else if (response.status !== 404 && kept) files[name] = kept;
      }),
    );
    if (Object.keys(files).length === 0) throw new Error('no skills read');
    this.snapshot = {
      fetchedAt: this.deps.now(),
      listEtag: list.headers.get('etag') ?? before.listEtag,
      files,
    };
    await this.deps.cache?.write(folder, this.snapshot).catch(() => undefined);
  }
}
