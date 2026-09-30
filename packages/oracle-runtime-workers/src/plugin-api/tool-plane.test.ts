import { describe, expect, it, vi } from 'vitest';
import { makeRuntimeContext, makeTool } from '../core/test-fixtures';
import {
  adminToolCapability,
  canAccessToolPlane,
  requireToolPlane,
  toolPlaneOf,
} from './tool-plane';

describe('tool privilege planes', () => {
  it('defaults tools to the orchestration plane', () => {
    expect(toolPlaneOf(makeTool('read_topic'))).toBe('orchestration');
    expect(
      canAccessToolPlane(makeRuntimeContext(), makeTool('read_topic')),
    ).toBe(true);
  });

  it('requires a tool-specific UCAN for admin-plane tools', () => {
    const tool = makeTool('grant_authority', { plane: 'admin' });
    const capability = adminToolCapability(tool.name);
    const base = makeRuntimeContext();
    const requireCapability = vi.fn(() => {
      throw new Error('missing admin delegation');
    });
    const denied = makeRuntimeContext({
      ucan: {
        ...base.ucan,
        hasCapability: (resource, action) =>
          resource === capability.resource &&
          action === capability.action
            ? false
            : base.ucan.hasCapability(resource, action),
        requireCapability,
      },
    });

    expect(canAccessToolPlane(denied, tool)).toBe(false);
    expect(() => requireToolPlane(denied, tool)).toThrow(
      'missing admin delegation',
    );
    expect(requireCapability).toHaveBeenCalledWith(
      capability.resource,
      capability.action,
    );

    const allowedBase = makeRuntimeContext();
    const allowed = makeRuntimeContext({
      ucan: {
        ...allowedBase.ucan,
        hasCapability: () => true,
        requireCapability: () => undefined,
      },
    });
    expect(canAccessToolPlane(allowed, tool)).toBe(true);
    expect(() => requireToolPlane(allowed, tool)).not.toThrow();
  });
});
