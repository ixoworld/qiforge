import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool } from '../../plugin-api/types.js';
import type { SkillsUcanBuilder } from './skills-ucan.js';

/**
 * Raw capsule shape returned by ai-skills. Validated via Zod at the network
 * boundary so a malformed registry response surfaces as a clean parse error
 * rather than a downstream type-confusion bug.
 */
const capsuleSchema = z.object({
  cid: z.string(),
  name: z.string(),
  description: z.string().default(''),
  license: z.string().nullable().optional(),
  compatibility: z.string().nullable().optional(),
  allowedTools: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  archiveSize: z.number().optional(),
  createdAt: z.string().optional(),
  // Set by ai-skills when the response row is private (i.e. owned by the
  // caller). Absent for public rows.
  visibility: z.enum(['public', 'private']).optional(),
  ownerDid: z.string().nullable().optional(),
  oracleDid: z.string().nullable().optional(),
});
type Capsule = z.infer<typeof capsuleSchema>;

const paginationSchema = z.object({
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

const listResponseSchema = z.object({
  capsules: z.array(capsuleSchema),
  pagination: paginationSchema,
});

const searchResponseSchema = z.object({
  query: z.string(),
  count: z.number(),
  capsules: z.array(capsuleSchema),
});

/** Normalised skill record exposed to the agent. */
interface MergedSkill {
  title: string;
  description: string;
  path: string;
  /** `public` — registry skill visible to everyone; `private` — owned by the current (oracle, user) pair. */
  source: 'public' | 'private';
  cid?: string;
  createdAt?: string;
}

const LIST_DESCRIPTION = `List available skills from the IXO skills registry — the caller's **published** private skills first, then public registry skills.

Each entry includes:
- title: skill name
- description: skill description
- path: absolute sandbox path to the skill folder
- source: "private" (your published skill) or "public" (registry)
- cid: required by load_skill and by sandbox_run (when the run depends on the skill). Never use a CID as a file path.`;

const SEARCH_DESCRIPTION = `Search the caller's published skills and the public IXO registry by query.

Matching published (private) skills come first, then public registry results. Each entry includes title, description, path, source ("private" | "public"), and cid.`;

const listSchema = z.object({
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe('Optional: number of skills to return (1-100, default: 20).'),
  offset: z
    .number()
    .min(0)
    .optional()
    .describe('Optional: pagination offset (default: 0).'),
});

const searchSchema = z.object({
  q: z
    .string()
    .min(1, 'Search query is required')
    .describe(
      'Search query (e.g. "pptx", "invoice", "presentation", "docx"). Required.',
    ),
  limit: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .describe('Optional: max results to return (1-50, default: 10).'),
});

function normalizeRegistryCapsule(capsule: Capsule): MergedSkill {
  return {
    title: capsule.name,
    description: capsule.description ?? '',
    path: `/workspace/skills/${capsule.name}`,
    source: capsule.visibility === 'private' ? 'private' : 'public',
    cid: capsule.cid,
    createdAt: capsule.createdAt
      ? new Date(capsule.createdAt).toISOString()
      : undefined,
  };
}

interface RegistryFetcherOptions {
  baseUrl: string;
  network: string;
  skillsUcan: string | undefined;
}

/**
 * Build the auth/network header set for outbound ai-skills requests. When a
 * UCAN invocation is available, ai-skills returns the caller's private
 * skills alongside the public ones; without it, only public rows come back.
 *
 * `X-IXO-Network` is a routing hint for ai-skills' did:ixo resolver, not a
 * capsule-storage axis.
 */
function buildRegistryHeaders(opts: RegistryFetcherOptions): HeadersInit {
  const headers: Record<string, string> = {
    'X-IXO-Network': opts.network,
  };
  if (opts.skillsUcan) {
    headers['Authorization'] = `Bearer ${opts.skillsUcan}`;
    headers['X-Auth-Type'] = 'ucan';
  }
  return headers;
}

type RegistryListResponse = z.infer<typeof listResponseSchema>;

async function fetchRegistryCapsules(
  opts: RegistryFetcherOptions,
  limit: number,
  offset: number,
): Promise<RegistryListResponse> {
  const url = new URL('/capsules', opts.baseUrl);
  url.searchParams.set('limit', limit.toString());
  url.searchParams.set('offset', offset.toString());

  const response = await fetch(url.toString(), {
    headers: buildRegistryHeaders(opts),
  });
  if (!response.ok) {
    throw new Error(`List skills failed: ${response.statusText}`);
  }
  return listResponseSchema.parse(await response.json());
}

async function searchRegistryCapsules(
  opts: RegistryFetcherOptions,
  q: string,
  limit: number,
): Promise<Capsule[]> {
  const url = new URL('/capsules/search', opts.baseUrl);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', limit.toString());

  const response = await fetch(url.toString(), {
    headers: buildRegistryHeaders(opts),
  });
  if (!response.ok) {
    throw new Error(`Search skills failed: ${response.statusText}`);
  }

  const data = searchResponseSchema.parse(await response.json());

  // Dedup by name. When a private (caller-owned) and a public row share a
  // name, prefer the private one — the user's own skill always wins. Among
  // entries of the same source, keep the newest by createdAt.
  const skillsMap = new Map<string, Capsule>();
  for (const capsule of data.capsules) {
    const existing = skillsMap.get(capsule.name);
    if (!existing) {
      skillsMap.set(capsule.name, capsule);
      continue;
    }
    const incomingPrivate = capsule.visibility === 'private';
    const existingPrivate = existing.visibility === 'private';
    if (incomingPrivate && !existingPrivate) {
      skillsMap.set(capsule.name, capsule);
      continue;
    }
    if (!incomingPrivate && existingPrivate) {
      continue;
    }
    // Same visibility tier — keep the newer one.
    const isNewer =
      capsule.createdAt && existing.createdAt
        ? new Date(capsule.createdAt).getTime() >
          new Date(existing.createdAt).getTime()
        : false;
    if (isNewer) skillsMap.set(capsule.name, capsule);
  }
  return Array.from(skillsMap.values());
}

export interface SkillsToolsOptions {
  /** Resolved at boot from the plugin's `configSchema`. */
  baseUrl: string;
  /**
   * Routing hint forwarded to ai-skills as `X-IXO-Network`. Defaults to
   * `mainnet` at the plugin layer when `NETWORK` is absent from config.
   */
  network: string;
  /** Mints the optional `ixo:skills` UCAN per call. */
  ucanBuilder: SkillsUcanBuilder;
}

/**
 * Build the two skills tools — `list_skills` and `search_skills`. Both close
 * over the registry base URL but defer UCAN minting to the handler so each
 * call resolves the freshest invocation for the current user.
 */
export function createSkillsTools(opts: SkillsToolsOptions): PluginTool[] {
  const list = tool(
    async (rawArgs, runCtx) => {
      const params = listSchema.parse(rawArgs);
      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;

      const skillsUcan = await opts.ucanBuilder(opts.baseUrl, runCtx);

      const registryResult = await fetchRegistryCapsules(
        { baseUrl: opts.baseUrl, network: opts.network, skillsUcan },
        limit,
        offset,
      );

      const registry = registryResult.capsules.map(normalizeRegistryCapsule);
      const privateRegistry = registry.filter((s) => s.source === 'private');
      const publicRegistry = registry.filter((s) => s.source === 'public');
      const skills: MergedSkill[] = [...privateRegistry, ...publicRegistry];

      return {
        skills,
        pagination: registryResult.pagination,
        privateSkillCount: privateRegistry.length,
      };
    },
    {
      name: 'list_skills',
      description: LIST_DESCRIPTION,
      schema: listSchema,
    },
  );

  const search = tool(
    async (rawArgs, runCtx) => {
      const params = searchSchema.parse(rawArgs);
      const limit = params.limit ?? 10;

      const skillsUcan = await opts.ucanBuilder(opts.baseUrl, runCtx);

      const capsules = await searchRegistryCapsules(
        { baseUrl: opts.baseUrl, network: opts.network, skillsUcan },
        params.q,
        limit,
      );

      const registry = capsules.map(normalizeRegistryCapsule);
      const privateRegistry = registry.filter((s) => s.source === 'private');
      const publicRegistry = registry.filter((s) => s.source === 'public');
      const skills: MergedSkill[] = [...privateRegistry, ...publicRegistry];

      return {
        query: params.q,
        count: skills.length,
        privateSkillCount: privateRegistry.length,
        skills,
      };
    },
    {
      name: 'search_skills',
      description: SEARCH_DESCRIPTION,
      schema: searchSchema,
    },
  );

  return [list, search];
}
