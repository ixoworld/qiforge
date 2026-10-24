import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { makeRuntimeContext, makeTool } from '../../test-fixtures';
import {
  guardSkillExecution,
  inspectCapsule,
  inspectSkillReference,
  type CapsuleInspection,
} from './capsule-inspection';
import { skillContractSchema } from './skill-contract';
import { createSkillsTools } from './skills-tools';

const cid = 'QmYwAPJzv5CZsnAzt8auVTLWHtUAwKPWyVYFQnwxKZ3Uez';
const contract = skillContractSchema.parse({
  schemaVersion: 1,
  skillName: 'example',
  runtime: 'qiforge-workers',
  audiences: ['private'],
  effects: ['read'],
  requiredTools: [{ name: 'ixo_files_search', effect: 'read' }],
  requiredCapabilities: [],
  requiredServices: [],
});
const inspection: CapsuleInspection = {
  cid,
  visibility: 'public',
  skillName: 'example',
  archiveSha256: 'a'.repeat(64),
  archiveSize: 1000,
  declaration: { status: 'validated', contract },
};
const options = {
  baseUrl: 'https://registry.example',
  network: 'testnet',
  ucanBuilder: async () => 'private-invocation',
};
const context = () =>
  makeRuntimeContext({ skillAudience: async () => 'private' });
const inventory = () =>
  Promise.resolve([makeTool('ixo_files_search', { effect: 'read' })]);

afterEach(() => vi.unstubAllGlobals());

describe('CID-scoped skill boundary', () => {
  it.each(['load_skill', 'sandbox_run'])(
    'checks %s before forwarding and preserves upstream result shape',
    async (name) => {
      const handler = vi.fn(async () => ({
        success: true,
        skillFiles: ['/workspace/skills/example/SKILL.md'],
      }));
      const original = makeTool(name, {
        handler,
        schema: z.object({ code: z.string().optional() }),
      });
      const inspect = vi.fn(async () => inspection);
      const guarded = guardSkillExecution(original, inventory, inspect);
      const args = guarded.schema.parse({ cid, code: 'true' });
      expect(args).toHaveProperty('cid', cid);
      const result = await guarded.handler(args, context());
      expect(result).toMatchObject({
        success: true,
        skillFiles: ['/workspace/skills/example/SKILL.md'],
        skillContractCheck: {
          status: 'dependencies_checked',
          effectEnforced: false,
          mountIntegrity: 'unverified',
        },
      });
      expect(inspect).toHaveBeenCalledWith({ cid }, expect.any(Object));
      expect(handler).toHaveBeenCalledOnce();
    },
  );

  it.each(['load_skill', 'sandbox_run'])(
    'refuses %s when a required tool was removed after discovery',
    async (name) => {
      const handler = vi.fn();
      let present = true;
      const current = async () => (present ? await inventory() : []);
      const guarded = guardSkillExecution(
        makeTool(name, { handler }),
        current,
        async () => inspection,
      );
      present = false;
      expect(await guarded.handler({ cid }, context())).toEqual({
        status: 'blocked',
        reasons: ['missing_tool:ixo_files_search'],
      });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each(['legacy', 'unsupported'] as const)(
    'keeps %s capsules reference-only',
    async (status) => {
      const handler = vi.fn();
      const guarded = guardSkillExecution(
        makeTool('load_skill', { handler }),
        inventory,
        async () => ({ ...inspection, declaration: { status } }),
      );
      expect(await guarded.handler({ cid }, context())).toMatchObject({
        status: 'reference_only',
        reasons: [`${status}_contract`],
      });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('fails closed without an inspector, on malformed inspection, or CID substitution', async () => {
    for (const inspect of [
      undefined,
      async () => ({}),
      async () => ({ ...inspection, cid: cid.slice(0, -1) + 'A' }),
    ]) {
      const handler = vi.fn();
      const guarded = guardSkillExecution(
        makeTool('load_skill', { handler }),
        inventory,
        inspect,
      );
      expect(await guarded.handler({ cid }, context())).toEqual({
        status: 'blocked',
        reasons: ['inspection_unavailable'],
      });
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it('blocks unavailable, read-misclassified search authorization and unproven gateway compatibility', async () => {
    const searchContract = {
      ...contract,
      requiredTools: [
        { name: 'search_gateway_authorize', effect: 'write' as const },
      ],
      requiredServices: [
        { id: 'ixo-search-gateway', profile: 'delegated-search-v1' },
      ],
    };
    const guarded = guardSkillExecution(
      makeTool('sandbox_run'),
      async () => [makeTool('search_gateway_authorize')],
      async () => ({
        ...inspection,
        declaration: { status: 'validated', contract: searchContract },
      }),
    );
    expect(await guarded.handler({ cid }, context())).toEqual({
      status: 'blocked',
      reasons: [
        'tool_effect_mismatch:search_gateway_authorize',
        'unsupported_service_profile:ixo-search-gateway:delegated-search-v1',
      ],
    });
  });

  it('rechecks the host capability evaluator at invocation', async () => {
    let granted = true;
    const ctx = context();
    ctx.ucan.hasCapability = () => granted;
    const handler = vi.fn();
    const guarded = guardSkillExecution(
      makeTool('load_skill', { handler }),
      inventory,
      async () => ({
        ...inspection,
        declaration: {
          status: 'validated',
          contract: {
            ...contract,
            requiredCapabilities: [
              { resource: 'ixo:sandbox', action: 'sandbox/run' },
            ],
          },
        },
      }),
    );
    granted = false;
    expect(await guarded.handler({ cid }, ctx)).toMatchObject({
      status: 'blocked',
      reasons: ['missing_capability:ixo:sandbox:sandbox/run'],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a delegation that expires after discovery using the real host clock check', async () => {
    const delegation = {
      raw: 'fixture',
      expiration: Math.floor(Date.now() / 1000) + 60,
      capabilities: [{ resource: 'ixo:sandbox', action: 'sandbox/*' }],
    };
    const ctx = makeRuntimeContext(
      { skillAudience: async () => 'private' },
      {
        runConfig: {
          context: {
            user: {
              did: 'did:ixo:user1',
              matrixUserId: '@user:example.org',
              ucanDelegation: delegation,
            },
            session: {
              id: 'session-1',
              client: 'portal',
              requestId: 'request-1',
            },
          },
        },
      },
    );
    expect(ctx.ucan.hasCapability('ixo:sandbox', 'sandbox/*')).toBe(true);
    const handler = vi.fn();
    const guarded = guardSkillExecution(
      makeTool('load_skill', { handler }),
      inventory,
      async () => ({
        ...inspection,
        declaration: {
          status: 'validated',
          contract: {
            ...contract,
            requiredCapabilities: [
              { resource: 'ixo:sandbox', action: 'sandbox/*' },
            ],
          },
        },
      }),
    );
    delegation.expiration = Math.floor(Date.now() / 1000) - 1;
    expect(await guarded.handler({ cid }, ctx)).toMatchObject({
      status: 'blocked',
      reasons: ['missing_capability:ixo:sandbox:sandbox/*'],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('blocks audience changes during inspection or inventory resolution', async () => {
    let audience: 'private' | 'shared' = 'private';
    const ctx = makeRuntimeContext({ skillAudience: async () => audience });
    const handler = vi.fn();
    const guarded = guardSkillExecution(
      makeTool('load_skill', { handler }),
      async () => {
        audience = 'shared';
        return inventory();
      },
      async () => inspection,
    );
    expect(await guarded.handler({ cid }, ctx)).toMatchObject({
      status: 'blocked',
      reasons: ['audience_changed'],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('requires canonical CID for load, rejects aliases and preserves general shell without CID', async () => {
    const handler = vi.fn(async () => 'shell');
    const guarded = guardSkillExecution(
      makeTool('load_skill', { handler }),
      inventory,
      async () => inspection,
    );
    expect(await guarded.handler({}, context())).toEqual({
      status: 'blocked',
      reasons: ['capsule_cid_required'],
    });
    expect(await guarded.handler({ skill_cid: cid }, context())).toEqual({
      status: 'blocked',
      reasons: ['unsupported_cid_argument'],
    });
    expect(await guarded.handler({ cid: 'bad' }, context())).toEqual({
      status: 'blocked',
      reasons: ['invalid_skill_arguments'],
    });
    expect(handler).not.toHaveBeenCalled();
    const run = guardSkillExecution(
      makeTool('sandbox_run', { handler }),
      inventory,
      undefined,
    );
    expect(await run.handler({ code: 'true' }, context())).toBe('shell');
  });

  it('preserves downstream thrown errors rather than disguising them as inspection failures', async () => {
    const handler = vi.fn(async () => {
      throw new Error('upstream failed');
    });
    const guarded = guardSkillExecution(
      makeTool('sandbox_run', { handler }),
      inventory,
      async () => inspection,
    );
    await expect(guarded.handler({ cid }, context())).rejects.toThrow(
      'upstream failed',
    );
  });
});

describe('shell-free inspection', () => {
  function respond(body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(body)),
    );
  }

  it('uses the configured origin, current UCAN and exact CID, with redirects disabled', async () => {
    respond(inspection);
    await inspectCapsule({ cid }, context(), options);
    expect(fetch).toHaveBeenCalledWith(
      new URL(`https://registry.example/capsules/${cid}/inspect`),
      expect.objectContaining({
        redirect: 'manual',
        headers: {
          'X-IXO-Network': 'testnet',
          Authorization: 'Bearer private-invocation',
          'X-Auth-Type': 'ucan',
        },
      }),
    );
  });

  it.each([301, 302, 303, 307, 308])(
    'refuses inspection redirect %s without forwarding credentials to the destination',
    async (status) => {
      const request = vi.fn(
        async (_input: string | URL | Request) =>
          new Response(null, {
            status,
            headers: { Location: 'https://other.example/canary' },
          }),
      );
      vi.stubGlobal('fetch', request);
      expect(await inspectSkillReference({ cid }, context(), options)).toEqual({
        status: 'blocked',
        reasons: ['inspection_unavailable'],
      });
      expect(request).toHaveBeenCalledOnce();
      expect(String(request.mock.calls[0]?.[0])).not.toContain('other.example');
    },
  );

  it('reads the verified instruction without shell, secret access or credential output', async () => {
    respond({
      ...inspection,
      document: { path: 'SKILL.md', text: '# Instructions' },
    });
    const ctx = context();
    const secrets = vi.spyOn(ctx.secrets, 'getAll');
    const result = await inspectSkillReference(
      { cid, path: 'SKILL.md' },
      ctx,
      options,
    );
    expect(result).toMatchObject({
      status: 'reference_only',
      execution: 'unchecked',
      document: { text: '# Instructions' },
    });
    expect(JSON.stringify(result)).not.toContain('private-invocation');
    expect(secrets).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    async () => 'shared' as const,
    async () => {
      throw new Error('unavailable');
    },
  ])(
    'withholds private instructions from unknown/shared audience',
    async (skillAudience) => {
      respond({
        ...inspection,
        visibility: 'private',
        document: { path: 'SKILL.md', text: 'private document' },
      });
      const ctx = makeRuntimeContext({ skillAudience });
      const result = await inspectSkillReference(
        { cid, path: 'SKILL.md' },
        ctx,
        options,
      );
      expect(result).toEqual({
        status: 'blocked',
        reasons: ['private_reference_unavailable'],
      });
      expect(JSON.stringify(result)).not.toContain('private document');
    },
  );

  it.each([
    { ...inspection, archiveSha256: 'bad' },
    { ...inspection, document: { path: 'other.md', text: 'wrong path' } },
    { ...inspection, document: { path: 'SKILL.md', text: 'x'.repeat(65537) } },
  ])(
    'refuses invalid server metadata or document substitution',
    async (body) => {
      respond(body);
      expect(
        await inspectSkillReference(
          { cid, path: 'SKILL.md' },
          context(),
          options,
        ),
      ).toEqual({ status: 'blocked', reasons: ['inspection_unavailable'] });
    },
  );

  it('bounds streaming responses without relying on Content-Length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(512 * 1024 + 1))),
    );
    await expect(inspectCapsule({ cid }, context(), options)).rejects.toThrow(
      'too large',
    );
  });

  it('does not forward a turn-scoped audience reader to another user or session', () => {
    const currentAudience = async () => 'private' as const;
    const matching = makeRuntimeContext(
      {},
      {
        ambient: {
          skillScope: {
            userDid: 'did:ixo:user1',
            sessionId: 'session-1',
            currentAudience,
          },
        },
      },
    );
    const other = makeRuntimeContext(
      {},
      {
        ambient: {
          skillScope: {
            userDid: 'did:ixo:someone-else',
            sessionId: 'session-1',
            currentAudience,
          },
        },
      },
    );
    expect(matching.skillAudience).toBe(currentAudience);
    expect(other.skillAudience).toBeUndefined();
  });

  it.each(['list_skills', 'search_skills'])(
    'withholds authenticated %s counts when the audience changes',
    async (name) => {
      respond({
        capsules: [
          {
            cid,
            name: 'private',
            description: 'private',
            visibility: 'private',
          },
        ],
        pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
        query: 'private',
        count: 1,
      });
      let reads = 0;
      const ctx = makeRuntimeContext({
        skillAudience: async () => (++reads === 1 ? 'private' : 'shared'),
      });
      const handler = createSkillsTools(options).find(
        (tool) => tool.name === name,
      )?.handler;
      expect(
        await handler?.(name === 'search_skills' ? { q: 'private' } : {}, ctx),
      ).toEqual({ status: 'blocked', reasons: ['audience_changed'] });
    },
  );

  it('marks discovery unchecked and suppresses private rows without a private host audience', async () => {
    respond({
      capsules: [
        { cid, name: 'public', description: 'public' },
        { cid, name: 'private', description: 'private', visibility: 'private' },
      ],
      pagination: { total: 2, limit: 20, offset: 0, hasMore: false },
    });
    const list = createSkillsTools(options).find(
      (tool) => tool.name === 'list_skills',
    );
    const result = await list?.handler({}, makeRuntimeContext());
    expect(result).toMatchObject({
      skills: [{ title: 'public', execution: 'unchecked' }],
      privateSkillCount: 0,
    });
    expect(JSON.stringify(result)).not.toContain('"title":"private"');
  });
});
