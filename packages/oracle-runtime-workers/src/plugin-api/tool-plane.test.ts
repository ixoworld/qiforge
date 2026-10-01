import { describe, expect, it } from 'vitest';
import { delegationHasCapability } from '../core/runtime-context';
import {
  makeRunConfig,
  makeRuntimeContext,
  makeTool,
} from '../core/test-fixtures';
import {
  ADMIN_TOOL_RESOURCE,
  adminToolCapability,
  adminToolResource,
  canAccessToolPlane,
  requireToolPlane,
  toolPlaneOf,
} from './tool-plane';
import type { UcanDelegation } from './types';

type Grant = { resource: string; action: string };

/** A parsed delegation, the shape `WorkersUcanService.withCapabilities` produces. */
function delegation(
  capabilities: Grant[],
  expiration?: number,
): UcanDelegation {
  return {
    raw: 'delegation',
    capabilities,
    ...(expiration !== undefined ? { expiration } : {}),
  };
}

/** A real RuntimeContext whose turn delegation is `ucanDelegation`. */
function contextFor(ucanDelegation: UcanDelegation) {
  const run = makeRunConfig();
  return makeRuntimeContext(
    {},
    {
      runConfig: {
        context: {
          ...run.context,
          user: { ...run.context.user, ucanDelegation },
        },
      },
    },
  );
}

describe('tool privilege planes', () => {
  const deleteTool = makeTool('delete', { plane: 'admin' });

  it('defaults tools to the orchestration plane, which needs no capability', () => {
    expect(toolPlaneOf(makeTool('read_topic'))).toBe('orchestration');
    expect(
      canAccessToolPlane(
        contextFor(delegation([])),
        'topics',
        makeTool('read_topic'),
      ),
    ).toBe(true);
  });

  it('names an admin tool by plugin and tool, in `/` segments', () => {
    expect(adminToolResource('keys', 'delete')).toBe(
      'ixo:qiforge:admin-tool/keys/delete',
    );
    expect(adminToolCapability('keys', 'delete')).toEqual({
      resource: 'ixo:qiforge:admin-tool/keys/delete',
      action: 'admin-tool/invoke',
    });
    expect(() => adminToolResource('a/b', 'c')).toThrow(/without "\/"/);
    expect(() => adminToolResource('keys', '')).toThrow(/non-empty/);
  });

  it('the runtime matcher grants an admin resource by exact, plugin, root or `*` grant only', () => {
    const { resource, action } = adminToolCapability('keys', 'delete');
    const has = (grants: Grant[], expiration?: number) =>
      delegationHasCapability(delegation(grants, expiration), resource, action);

    expect(has([{ resource, action: 'admin-tool/invoke' }])).toBe(true);
    expect(
      has([
        {
          resource: 'ixo:qiforge:admin-tool/keys',
          action: 'admin-tool/invoke',
        },
      ]),
    ).toBe(true);
    expect(
      has([{ resource: ADMIN_TOOL_RESOURCE, action: 'admin-tool/invoke' }]),
    ).toBe(true);
    expect(has([{ resource: '*', action: '*' }])).toBe(true);
    expect(has([{ resource, action: 'admin-tool/*' }])).toBe(true);

    // A sibling whose name extends this one, another plugin's tool of the
    // same name, a narrower grant, or another ability: none of them.
    expect(
      has([
        {
          resource: 'ixo:qiforge:admin-tool/keys/delete_all',
          action: 'admin-tool/invoke',
        },
      ]),
    ).toBe(false);
    expect(
      has([
        {
          resource: 'ixo:qiforge:admin-tool/notes/delete',
          action: 'admin-tool/invoke',
        },
      ]),
    ).toBe(false);
    expect(
      has([
        {
          resource: 'ixo:qiforge:admin-tool/keys/delete/extra',
          action: 'admin-tool/invoke',
        },
      ]),
    ).toBe(false);
    expect(has([{ resource, action: 'fs/read' }])).toBe(false);

    // An expired delegation grants nothing, even `*`.
    const past = Math.floor(Date.now() / 1000) - 1;
    expect(has([{ resource: '*', action: '*' }], past)).toBe(false);
  });

  it('checks the turn delegation through ctx.ucan, before and at the call', () => {
    const denied = contextFor(
      delegation([
        {
          resource: 'ixo:qiforge:admin-tool/keys/delete_all',
          action: 'admin-tool/invoke',
        },
      ]),
    );
    expect(canAccessToolPlane(denied, 'keys', deleteTool)).toBe(false);
    expect(() => requireToolPlane(denied, 'keys', deleteTool)).toThrow(
      'Missing required capability: admin-tool/invoke on ixo:qiforge:admin-tool/keys/delete',
    );

    const granted = contextFor(
      delegation([
        {
          resource: 'ixo:qiforge:admin-tool/keys',
          action: 'admin-tool/invoke',
        },
      ]),
    );
    expect(canAccessToolPlane(granted, 'keys', deleteTool)).toBe(true);
    expect(() => requireToolPlane(granted, 'keys', deleteTool)).not.toThrow();
  });
});
