import { describe, expect, it } from 'vitest';
import { VfsNoDelegationError, VfsRequestError } from './ixo-vfs-store';
import {
  classifyOwnerCopyError,
  isRetryableOwnerCopyError,
  OwnerCopyUnavailableError,
  parseOwnerCopyFailure,
  toRpcError,
} from './owner-copy-errors';

describe('owner-copy error classification', () => {
  it('never retries a missing delegation or an auth rejection', () => {
    expect(
      classifyOwnerCopyError(
        new VfsNoDelegationError('did:ixo:u', 'no-capability'),
      ),
    ).toBe('NO_VFS_DELEGATION');
    expect(
      classifyOwnerCopyError(new VfsRequestError(403, '', 'VFS GET → 403')),
    ).toBe('VFS_AUTH_FAILED');
    expect(
      classifyOwnerCopyError(new VfsRequestError(401, '', 'VFS GET → 401')),
    ).toBe('VFS_AUTH_FAILED');
    expect(
      isRetryableOwnerCopyError(
        new VfsNoDelegationError('did:ixo:u', 'no-capability'),
      ),
    ).toBe(false);
  });

  it('retries transient failures: 5xx, 429, network', () => {
    for (const err of [
      new VfsRequestError(503, '', 'VFS GET → 503'),
      new VfsRequestError(429, '', 'VFS GET → 429'),
      new TypeError('fetch failed'),
    ]) {
      expect(classifyOwnerCopyError(err)).toBe('OWNER_COPY_UNAVAILABLE');
      expect(isRetryableOwnerCopyError(err)).toBe(true);
    }
  });

  it('carries the status code and retryability the shell answers with', () => {
    const transient = new OwnerCopyUnavailableError(
      'did:ixo:u',
      new VfsRequestError(503, '', 'VFS GET → 503'),
      4,
    );
    expect(transient.httpStatus).toBe(503);
    expect(transient.retryable).toBe(true);
    expect(transient.message).toMatch(/after 4 attempt/);
    const noGrant = new OwnerCopyUnavailableError(
      'did:ixo:u',
      new VfsNoDelegationError('did:ixo:u', 'no-capability'),
      1,
    );
    expect(noGrant.httpStatus).toBe(403);
    expect(noGrant.retryable).toBe(false);
    expect(noGrant.code).toBe('NO_VFS_DELEGATION');
    expect(noGrant.message).toMatch(/ixo:filesystem over \/\.oracles/);
  });
});

describe('owner-copy failures across the RPC boundary', () => {
  const failure = new OwnerCopyUnavailableError(
    'did:ixo:u',
    new VfsNoDelegationError('did:ixo:u', 'no-capability'),
    1,
  );

  it('reads the class directly inside the object', () => {
    expect(parseOwnerCopyFailure(failure)).toEqual({
      code: 'NO_VFS_DELEGATION',
      httpStatus: 403,
      retryable: false,
      message: failure.message,
    });
  });

  it('survives serialisation as a plain Error with only a message', () => {
    // DO RPC hands the caller `new Error(message)`: no class, name or fields.
    const overRpc = new Error(toRpcError(failure).message);
    expect(parseOwnerCopyFailure(overRpc)).toEqual({
      code: 'NO_VFS_DELEGATION',
      httpStatus: 403,
      retryable: false,
      message: failure.message,
    });
  });

  it('maps a transient VFS failure to a retryable 503', () => {
    const transient = new OwnerCopyUnavailableError(
      'did:ixo:u',
      new VfsRequestError(503, '', 'VFS GET → 503'),
      3,
    );
    const overRpc = new Error(toRpcError(transient).message);
    expect(parseOwnerCopyFailure(overRpc)).toMatchObject({
      code: 'OWNER_COPY_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    });
  });

  it('still recognises the raw no-delegation error by name', () => {
    expect(
      parseOwnerCopyFailure(new VfsNoDelegationError('x', 'no-delegation')),
    ).toMatchObject({
      code: 'NO_VFS_DELEGATION',
      httpStatus: 403,
    });
  });

  it('returns null for anything else, including JSON-looking messages', () => {
    expect(parseOwnerCopyFailure(new Error('boom'))).toBeNull();
    expect(parseOwnerCopyFailure(new Error('{"code":"X"}'))).toBeNull();
    expect(parseOwnerCopyFailure('string')).toBeNull();
  });
});
