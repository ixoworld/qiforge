import { describe, expect, it, vi } from 'vitest';
import type { HostFacts } from '@ixo/agent-tools';
import { makeRuntimeContext } from '../core/test-fixtures';
import { createIxoSourceAuthority } from './source-authority';

const context: HostFacts = {
  userDid: 'did:ixo:alice',
  oracleDid: 'did:ixo:oracle',
  network: 'devnet',
  sessionId: 'session-a',
  roomId: '!room:ixo.test',
  visibility: 'private',
  timezone: 'Asia/Singapore',
};
const origins = {
  subscriptions: 'https://subscriptions.ixo.test',
  memory: 'https://memory.ixo.test',
  vfs: 'https://vfs.ixo.test',
  yellowcard: 'https://yellowcard.ixo.test',
};
function setup() {
  const runtime = makeRuntimeContext();
  const createInvocationFromDelegation = vi
    .fn(runtime.ucan.createInvocationFromDelegation)
    .mockResolvedValue({ invocation: 'fresh-invocation' });
  const getServiceDelegation = vi
    .fn(runtime.ucan.getServiceDelegation)
    .mockResolvedValue({ token: 'vfs-proof', with: 'ixo:filesystem' });
  const resolveServiceDid = vi
    .fn(runtime.ucan.resolveServiceDid)
    .mockResolvedValue('did:web:store.ixo.test');
  const currentDelegation = vi.fn(async () => ({
    raw: 'current-proof',
    capabilities: [
      { with: 'ixo:subscriptions', can: 'subscriptions/read' },
      { with: 'ixo:memory', can: 'memory/search' },
      { with: 'ixo:yellowcard', can: 'yellowcard/agent-read' },
      { with: 'ixo:yellowcard', can: 'yellowcard/agent-quote' },
    ],
  }));
  const authority = createIxoSourceAuthority({
    ucan: {
      ...runtime.ucan,
      hasSigningKey: () => true,
      createInvocationFromDelegation,
      getServiceDelegation,
      resolveServiceDid,
    },
    context,
    origins,
    storeUrl: 'https://store.ixo.test',
    currentDelegation,
  });
  return {
    authority,
    createInvocationFromDelegation,
    getServiceDelegation,
    resolveServiceDid,
    currentDelegation,
  };
}
describe('trusted IXO source authority', () => {
  it('mints exact read/quote abilities for fixed audiences with a sixty-second lifetime', async () => {
    const f = setup();
    await f.authority.subscriptions(context);
    await f.authority.memory(context);
    await f.authority.yellowcard(context, 'read');
    await f.authority.yellowcard(context, 'quote');
    expect(f.createInvocationFromDelegation.mock.calls).toEqual([
      [
        'current-proof',
        'did:web:subscriptions.ixo.test',
        { can: 'subscriptions/read', with: 'ixo:subscriptions' },
        { maxTtlSeconds: 60 },
      ],
      [
        'current-proof',
        'did:web:memory.ixo.test',
        { can: 'memory/search', with: 'ixo:memory' },
        { maxTtlSeconds: 60 },
      ],
      [
        'current-proof',
        'did:web:yellowcard.ixo.test',
        { can: 'yellowcard/agent-read', with: 'ixo:yellowcard' },
        { maxTtlSeconds: 60 },
      ],
      [
        'current-proof',
        'did:web:yellowcard.ixo.test',
        { can: 'yellowcard/agent-quote', with: 'ixo:yellowcard' },
        { maxTtlSeconds: 60 },
      ],
    ]);
    expect(f.currentDelegation).toHaveBeenCalledTimes(8);
  });
  it('requires a fresh VFS store lookup and never widens a restricted resource', async () => {
    const f = setup();
    await f.authority.vfs(context, 'list');
    expect(f.getServiceDelegation).toHaveBeenLastCalledWith(context.userDid, {
      storeUrl: 'https://store.ixo.test',
      resource: 'ixo:filesystem',
      requiredAbility: 'fs/list',
      fresh: true,
    });
    expect(f.createInvocationFromDelegation).toHaveBeenLastCalledWith(
      'vfs-proof',
      'did:web:vfs.ixo.test',
      { can: 'fs/list', with: 'ixo:filesystem' },
      { maxTtlSeconds: 60 },
    );
    f.getServiceDelegation.mockResolvedValue({
      token: 'limited-proof',
      with: 'ixo:filesystem/projects',
    });
    expect(await f.authority.vfs(context, 'read')).toBeNull();
    expect(f.createInvocationFromDelegation).toHaveBeenCalledTimes(1);
  });
  it('rejects a changed store audience before sending the oracle invocation', async () => {
    const f = setup();
    f.resolveServiceDid.mockResolvedValue('did:web:evil.test');
    await expect(f.authority.vfs(context, 'list')).rejects.toThrow(
      'audience mismatch',
    );
    expect(f.getServiceDelegation).not.toHaveBeenCalled();
  });
  it('binds every host fact and re-reads revocation on each request', async () => {
    const f = setup();
    await expect(
      f.authority.memory({ ...context, sessionId: 'other' }),
    ).rejects.toThrow('context mismatch');
    await f.authority.memory(context);
    f.currentDelegation.mockResolvedValue({ raw: '', capabilities: [] });
    expect(await f.authority.memory(context)).toBeNull();
    expect(f.createInvocationFromDelegation).toHaveBeenCalledTimes(1);
  });
  it('fails closed for service-store outages and missing grants', async () => {
    const f = setup();
    f.getServiceDelegation.mockResolvedValue({ error: 'store-error' });
    await expect(f.authority.vfs(context, 'list')).rejects.toThrow(
      'unavailable',
    );
    f.getServiceDelegation.mockResolvedValue({ error: 'no-delegation' });
    expect(await f.authority.vfs(context, 'list')).toBeNull();
  });
});

it('does not mint source authority from native-only consent', async () => {
  const f = setup();
  f.currentDelegation.mockResolvedValue({
    raw: 'native-only',
    capabilities: [
      { with: 'ixo:agent-tools', can: 'agent-tools/ixo_account_get' },
    ],
  });
  expect(await f.authority.subscriptions(context)).toBeNull();
  expect(f.createInvocationFromDelegation).not.toHaveBeenCalled();
});

it('discards a credential minted after revocation', async () => {
  const f = setup();
  f.createInvocationFromDelegation.mockImplementation(async () => {
    f.currentDelegation.mockResolvedValue({ raw: '', capabilities: [] });
    return { invocation: 'must-not-use' };
  });
  expect(await f.authority.subscriptions(context)).toBeNull();
});

it('does not mint after a revocation during VFS delegation lookup', async () => {
  const f = setup();
  f.getServiceDelegation.mockImplementation(async () => {
    f.currentDelegation.mockResolvedValue({ raw: '', capabilities: [] });
    return { token: 'stale-proof', with: 'ixo:filesystem' };
  });
  expect(await f.authority.vfs(context, 'read')).toBeNull();
  expect(f.createInvocationFromDelegation).not.toHaveBeenCalled();
});

it('does not use a VFS credential minted after revocation', async () => {
  const f = setup();
  f.createInvocationFromDelegation.mockImplementation(async () => {
    f.currentDelegation.mockResolvedValue({ raw: '', capabilities: [] });
    return { invocation: 'must-not-use' };
  });
  expect(await f.authority.vfs(context, 'read')).toBeNull();
});
