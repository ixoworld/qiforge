import { HttpException, HttpStatus } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUCANValidator } from '@ixo/ucan';
import type { UCANValidator, ValidateResult } from '@ixo/ucan';
import { AuthHeaderMiddleware } from './auth-header.middleware.js';
import type { UcanService } from '../ucan/ucan.service.js';

// Hoisted mock — the middleware now statically imports `@ixo/ucan` (the
// dynamic import is gone for first-cache-miss latency wins), so we mock
// at module-init time and retarget per test via `vi.mocked(...)`.
vi.mock('@ixo/ucan', () => ({
  createUCANValidator: vi.fn(),
  createIxoDIDResolver: vi.fn(() => ({})),
  defineCapability: vi.fn(() => ({})),
}));

const mockedCreateUCANValidator = vi.mocked(createUCANValidator);

interface CacheMock extends Partial<Cache> {
  store: Map<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

function makeCache(): CacheMock {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k)),
    set: vi.fn(async (k: string, v: unknown) => {
      store.set(k, v);
    }),
  };
}

function makeConfig(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: vi.fn(<T>(key: string): T | undefined => values[key] as T | undefined),
    getOrThrow: vi.fn(<T>(key: string): T => {
      if (!(key in values)) {
        throw new Error(`Config "${key}" missing`);
      }
      return values[key] as T;
    }),
  } as unknown as ConfigService;
}

function makeUcanService(): UcanService {
  return {
    cacheDelegation: vi.fn(async () => undefined),
  } as unknown as UcanService;
}

function makeReq(headers: Record<string, string> = {}): Request {
  return {
    headers,
    originalUrl: '/test',
  } as unknown as Request;
}

function makeRes(): Response {
  return {} as Response;
}

const VALID_DELEGATION_RAW = 'eyJ.delegation.raw';
const ORACLE_DID = 'did:ixo:oracle123';
const USER_DID = 'did:ixo:user456';
const OTHER_DID = 'did:ixo:other789';

const FAIL_RESULT: ValidateResult = {
  ok: false,
  error: { code: 'INVALID_FORMAT', message: 'not mocked' },
};

/**
 * Build a fully-typed `UCANValidator` mock. `validate` backs invocation auth,
 * `validateDelegation` backs delegation auth — set whichever a test needs.
 */
function makeValidator(opts: {
  delegation?: ValidateResult;
  invocation?: ValidateResult;
}): UCANValidator {
  return {
    serverDid: ORACLE_DID,
    validateDelegation: async () => opts.delegation ?? FAIL_RESULT,
    validate: async () => opts.invocation ?? FAIL_RESULT,
  };
}

/** Headers carrying a bearer auth invocation (`X-Auth-Type: ucan`). */
function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'x-auth-type': 'ucan' };
}

describe('AuthHeaderMiddleware (UCAN-only)', () => {
  let cache: CacheMock;
  let cfg: ConfigService;
  let ucan: UcanService;
  let mw: AuthHeaderMiddleware;

  beforeEach(() => {
    cache = makeCache();
    cfg = makeConfig({
      ORACLE_DID,
      BLOCKSYNC_GRAPHQL_URL: 'https://blocksync.example/graphql',
    });
    ucan = makeUcanService();
    mw = new AuthHeaderMiddleware(cache as unknown as Cache, cfg, ucan);
    mockedCreateUCANValidator.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects requests without x-ucan-delegation header with 401', async () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await mw.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = (next as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as HttpException;
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect((req as unknown as { authData?: unknown }).authData).toBeUndefined();
  });

  it('does not call ucan validator when ORACLE_DID missing and rejects', async () => {
    const noOracleCfg = makeConfig({
      BLOCKSYNC_GRAPHQL_URL: 'https://blocksync.example/graphql',
    });
    const m = new AuthHeaderMiddleware(
      cache as unknown as Cache,
      noOracleCfg,
      ucan,
    );
    const req = makeReq({ 'x-ucan-delegation': VALID_DELEGATION_RAW });
    const next = vi.fn() as unknown as NextFunction;

    await m.use(req, makeRes(), next);

    const err = (next as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as HttpException;
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('populates req.authData from cache and calls next() on cache hit', async () => {
    const cachedAuth = {
      userDid: USER_DID,
      delegation: {
        issuer: USER_DID,
        audience: ORACLE_DID,
        capabilities: [{ resource: 'r', action: 'a' }],
        expiration: Math.floor(Date.now() / 1000) + 600,
      },
    };
    // Pre-populate cache; the key is sha256 of the header value with prefix `ucan_auth_`.
    // Easier: stub get() to return the cached value regardless of key.
    cache.get = vi.fn(async () => cachedAuth);

    const req = makeReq({ 'x-ucan-delegation': VALID_DELEGATION_RAW });
    const next = vi.fn() as unknown as NextFunction;

    await mw.use(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(
      (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
    ).toBeUndefined();
    expect(req.authData).toEqual({
      did: USER_DID,
      ucanDelegation: { ...cachedAuth.delegation, raw: VALID_DELEGATION_RAW },
    });
    expect(ucan.cacheDelegation).toHaveBeenCalledWith(
      USER_DID,
      VALID_DELEGATION_RAW,
      cachedAuth.delegation.expiration,
    );
    // UCAN-only contract: legacy OpenID field must not appear on authData
    const legacyField = ['user', 'OpenId', 'Token'].join('');
    expect(
      (req.authData as unknown as Record<string, unknown>)[legacyField],
    ).toBeUndefined();
  });

  it('validates delegation and populates req.authData on miss', async () => {
    const expiration = Math.floor(Date.now() / 1000) + 600;
    mockedCreateUCANValidator.mockResolvedValueOnce({
      validateDelegation: vi.fn(async () => ({
        ok: true,
        invoker: USER_DID,
        capability: { resource: 'r', action: 'a' },
        expiration,
      })),
    } as unknown as Awaited<ReturnType<typeof createUCANValidator>>);

    const req = makeReq({ 'x-ucan-delegation': VALID_DELEGATION_RAW });
    const next = vi.fn() as unknown as NextFunction;

    await mw.use(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(
      (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
    ).toBeUndefined();
    expect(req.authData.did).toBe(USER_DID);
    expect(req.authData.ucanDelegation.issuer).toBe(USER_DID);
    expect(req.authData.ucanDelegation.audience).toBe(ORACLE_DID);
    expect(req.authData.ucanDelegation.expiration).toBe(expiration);
    const legacyField2 = ['user', 'OpenId', 'Token'].join('');
    expect(
      (req.authData as unknown as Record<string, unknown>)[legacyField2],
    ).toBeUndefined();
    expect(cache.set).toHaveBeenCalled();
    expect(ucan.cacheDelegation).toHaveBeenCalledWith(
      USER_DID,
      VALID_DELEGATION_RAW,
      expiration,
    );
  });

  it('rejects with 401 when delegation validation fails', async () => {
    mockedCreateUCANValidator.mockResolvedValueOnce({
      validateDelegation: vi.fn(async () => ({
        ok: false,
        error: { code: 'BAD_SIG', message: 'bad signature' },
      })),
    } as unknown as Awaited<ReturnType<typeof createUCANValidator>>);

    const req = makeReq({ 'x-ucan-delegation': VALID_DELEGATION_RAW });
    const next = vi.fn() as unknown as NextFunction;

    await mw.use(req, makeRes(), next);

    const err = (next as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as HttpException;
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect((req as unknown as { authData?: unknown }).authData).toBeUndefined();
  });

  it('authenticates via invocation (no delegation) and leaves ucanDelegation empty', async () => {
    const expiration = Math.floor(Date.now() / 1000) + 300;
    mockedCreateUCANValidator.mockResolvedValue(
      makeValidator({
        invocation: { ok: true, invoker: USER_DID, expiration },
      }),
    );

    const req = makeReq(bearer('INV_TOKEN'));
    const next = vi.fn() as unknown as NextFunction;

    await mw.use(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(
      (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
    ).toBeUndefined();
    expect(req.authData.did).toBe(USER_DID);
    expect(req.authData.ucanDelegation.raw).toBe('');
    expect(ucan.cacheDelegation).not.toHaveBeenCalled();
  });

  it('invocation + matching delegation caches the delegation for downstream', async () => {
    const now = Math.floor(Date.now() / 1000);
    const delExp = now + 600;
    mockedCreateUCANValidator.mockResolvedValue(
      makeValidator({
        delegation: {
          ok: true,
          invoker: USER_DID,
          capability: { can: 'a', with: 'r' },
          expiration: delExp,
        },
        invocation: { ok: true, invoker: USER_DID, expiration: now + 300 },
      }),
    );

    const req = makeReq({
      ...bearer('INV_TOKEN'),
      'x-ucan-delegation': VALID_DELEGATION_RAW,
    });
    const next = vi.fn() as unknown as NextFunction;

    await mw.use(req, makeRes(), next);

    expect(req.authData.did).toBe(USER_DID);
    expect(req.authData.ucanDelegation.raw).toBe(VALID_DELEGATION_RAW);
    expect(ucan.cacheDelegation).toHaveBeenCalledWith(
      USER_DID,
      VALID_DELEGATION_RAW,
      delExp,
    );
  });

  it('ignores a delegation issued by someone other than the authenticated user', async () => {
    const now = Math.floor(Date.now() / 1000);
    mockedCreateUCANValidator.mockResolvedValue(
      makeValidator({
        delegation: {
          ok: true,
          invoker: OTHER_DID,
          capability: { can: 'a', with: 'r' },
          expiration: now + 600,
        },
        invocation: { ok: true, invoker: USER_DID, expiration: now + 300 },
      }),
    );

    const req = makeReq({
      ...bearer('INV_TOKEN'),
      'x-ucan-delegation': VALID_DELEGATION_RAW,
    });
    const next = vi.fn() as unknown as NextFunction;

    await mw.use(req, makeRes(), next);

    // Auth still succeeds (identity = invocation signer), but the mismatched
    // delegation is NOT trusted for downstream use.
    expect(req.authData.did).toBe(USER_DID);
    expect(req.authData.ucanDelegation.raw).toBe('');
    expect(ucan.cacheDelegation).not.toHaveBeenCalled();
  });

  it('rejects an invalid invocation with 401', async () => {
    mockedCreateUCANValidator.mockResolvedValue(
      makeValidator({
        invocation: {
          ok: false,
          error: { code: 'INVALID_SIGNATURE', message: 'bad sig' },
        },
      }),
    );

    const req = makeReq(bearer('INV_TOKEN'));
    const next = vi.fn() as unknown as NextFunction;

    await mw.use(req, makeRes(), next);

    const err = (next as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as HttpException;
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect((req as unknown as { authData?: unknown }).authData).toBeUndefined();
  });

  it('rejects an invocation whose TTL exceeds the server maximum with 401', async () => {
    const farFuture = Math.floor(Date.now() / 1000) + 100_000; // > 900s max
    mockedCreateUCANValidator.mockResolvedValue(
      makeValidator({
        invocation: { ok: true, invoker: USER_DID, expiration: farFuture },
      }),
    );

    const req = makeReq(bearer('INV_TOKEN'));
    const next = vi.fn() as unknown as NextFunction;

    await mw.use(req, makeRes(), next);

    const err = (next as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as HttpException;
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('rejects an invocation with no expiration with 401', async () => {
    mockedCreateUCANValidator.mockResolvedValue(
      makeValidator({ invocation: { ok: true, invoker: USER_DID } }),
    );

    const req = makeReq(bearer('INV_TOKEN'));
    const next = vi.fn() as unknown as NextFunction;

    await mw.use(req, makeRes(), next);

    const err = (next as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as HttpException;
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  });
});
