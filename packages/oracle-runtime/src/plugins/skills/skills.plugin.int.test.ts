/**
 * Skills plugin integration tests against the live IXO skills registry
 * (ai-skills).
 *
 * Why each test exists:
 *   - A1 list_skills: proves the registry base URL is reachable AND the
 *     `{ skills, pagination, privateSkillCount }` shape coming back is
 *     parseable by the plugin's Zod schema. A regression in the registry's
 *     response or the plugin's parser surfaces here.
 *   - A2 search_skills: proves the search endpoint accepts a query and
 *     returns the documented response shape. Independent of A1 because
 *     `/capsules` and `/capsules/search` are separate routes with
 *     separate response shapes.
 *   - B1 routing: a topic-specific user ask ("create a frontend HTML
 *     page") must route to a skills discovery tool (list or search) so
 *     the agent reuses an existing capsule before writing from scratch.
 *     Catches manifest drift that would move the model off skills.
 *
 * Skills plugin hard-depends on Sandbox (dependsOn: ['sandbox']), so both
 * are bundled. Tier A here doesn't exercise sandbox_run — only the skills
 * HTTP path. The full "find a skill and load it into the sandbox" flow is
 * exercised in the sandbox plugin's integration tests (A5 load_skill).
 *
 * No skip flags, no mocks. Missing env throws at file-load time.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  allCaps,
  ChatClient,
  createIntegrationOracle,
  createIntegrationRuntime,
  type IntegrationOracle,
  type IntegrationRuntime,
  mintUserDelegation,
  skillsCap,
  waitForMatrixLoaded,
} from '../../testing/integration/index.js';
import { SandboxPlugin } from '../sandbox/sandbox.plugin.js';
import { SkillsPlugin } from './skills.plugin.js';

const REQUIRED_ENV = [
  'ORACLE_DID',
  'ORACLE_ENTITY_DID',
  'TEST_USER_DID',
  'TEST_USER_MNEMONIC',
  'MATRIX_BASE_URL',
  'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
  'MATRIX_VALUE_PIN',
  'SECP_MNEMONIC',
  'OPEN_ROUTER_API_KEY',
  // SANDBOX_MCP_URL is required because SkillsPlugin.dependsOn = ['sandbox']
  // — the loader excludes skills if sandbox can't load.
  'SANDBOX_MCP_URL',
] as const;

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(
    `skills.plugin.int.test.ts requires the following env vars (see packages/oracle-runtime/.env.integration): ${missing.join(', ')}`,
  );
}

const SKILLS_CAPS = [{ resource: skillsCap.with, action: skillsCap.can }];

interface MergedSkill {
  title: string;
  description: string;
  path: string;
  source: 'public' | 'private';
  cid?: string;
}

interface ListResponse {
  skills: MergedSkill[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  privateSkillCount: number;
}

interface SearchResponse {
  query: string;
  count: number;
  privateSkillCount: number;
  skills: MergedSkill[];
}

describe('skills plugin — integration', () => {
  let oracle: IntegrationOracle;
  let runtime: IntegrationRuntime;
  let chatClient: ChatClient;
  let sharedSessionId: string;

  beforeAll(async () => {
    oracle = await createIntegrationOracle({
      plugins: [],
      bundledPlugins: [new SandboxPlugin(), new SkillsPlugin()],
    });
    await waitForMatrixLoaded(oracle);

    const delegation = await mintUserDelegation({
      userMnemonic: process.env.TEST_USER_MNEMONIC!,
      oracleDid: process.env.ORACLE_DID!,
      userDid: process.env.TEST_USER_DID!,
      capabilities: allCaps,
    });

    runtime = await createIntegrationRuntime({
      plugins: [new SandboxPlugin(), new SkillsPlugin()],
      user: { did: process.env.TEST_USER_DID! },
      delegation,
      capabilities: SKILLS_CAPS,
      ucan: oracle.app.ambient.ucan,
    });

    chatClient = new ChatClient(oracle.baseUrl, { delegation });
    sharedSessionId = await chatClient.createSession();
  }, 180_000);

  afterAll(async () => {
    await runtime?.close();
    await oracle?.close();
  });

  // ─── Tier A ───────────────────────────────────────────────────────────

  test('A1 — list_skills returns parsed { skills, pagination, privateSkillCount }', async () => {
    const result = (await runtime.invokeTool('list_skills', {
      limit: 5,
    })) as ListResponse;

    expect(Array.isArray(result.skills)).toBe(true);
    expect(typeof result.privateSkillCount).toBe('number');
    expect(result.pagination).toMatchObject({
      total: expect.any(Number),
      limit: expect.any(Number),
      offset: expect.any(Number),
      hasMore: expect.any(Boolean),
    });
    // Each row's shape is enforced by the plugin's Zod parser — verifying
    // one row catches a registry response that omits a required field.
    // If skills is not empty, perform additional assertions.
    // Use a "return" guard to avoid expect inside the conditional.
    if (result.skills.length === 0) return;
    const first = result.skills[0]!;
    expect(typeof first.title).toBe('string');
    expect(typeof first.path).toBe('string');
    expect(['public', 'private']).toContain(first.source);
  }, 60_000);

  test('A2 — search_skills returns parsed { query, count, skills } shape', async () => {
    // Using a generic query rather than a specific cid — the public registry
    // catalog may evolve, so we assert on shape, not on which skills match.
    const q = 'invoice';
    const result = (await runtime.invokeTool('search_skills', {
      q,
      limit: 10,
    })) as SearchResponse;

    expect(result.query).toBe(q);
    expect(typeof result.count).toBe('number');
    expect(typeof result.privateSkillCount).toBe('number');
    expect(Array.isArray(result.skills)).toBe(true);
    expect(result.skills.length).toBeLessThanOrEqual(1);
  }, 60_000);

  // ─── Tier B ───────────────────────────────────────────────────────────

  test(
    'B1 — "I need to create a frontend page" routes to a skills tool',
    async () => {
      const results = await chatClient.send(
        sharedSessionId,
        'I need to create a nice frontend HTML page for my grocery shop check the frontend skill and make it look nice. Can you help?',
      );

      const tc = results.body.messages.reduce(
        (acc, m) => (m.toolCalls ? acc.concat(m.toolCalls) : acc),
        [] as Array<
          NonNullable<
            (typeof results.body.messages)[number]['toolCalls']
          >[number]
        >,
      );

      const skillsCalls = tc?.filter((t) =>
        ['search_skills', 'list_skills'].includes(t.name),
      );

      expect(
        skillsCalls.length,
        `expected list_skills or search_skills; saw toolCalls: ${tc
          .map((t) => t.name)
          .join(', ')}`,
      ).toBeGreaterThan(0);
    },
    180_000,
  );
});
