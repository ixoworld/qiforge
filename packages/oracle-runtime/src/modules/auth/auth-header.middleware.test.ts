import { HttpException, HttpStatus } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthHeaderMiddleware } from './auth-header.middleware.js';
import type { UcanService } from '../ucan/ucan.service.js';

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
    expect((next as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBeUndefined();
    expect(req.authData).toEqual({
      did: USER_DID,
      ucanDelegation: cachedAuth.delegation,
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
    vi.doMock('@ixo/ucan', () => ({
      createUCANValidator: vi.fn(async () => ({
        validateDelegation: vi.fn(async () => ({
          ok: true,
          invoker: USER_DID,
          capability: { resource: 'r', action: 'a' },
          expiration,
        })),
      })),
      createIxoDIDResolver: vi.fn(() => ({})),
    }));

    const req = makeReq({ 'x-ucan-delegation': VALID_DELEGATION_RAW });
    const next = vi.fn() as unknown as NextFunction;

    await mw.use(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((next as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBeUndefined();
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

    vi.doUnmock('@ixo/ucan');
  });

  it('rejects with 401 when delegation validation fails', async () => {
    vi.doMock('@ixo/ucan', () => ({
      createUCANValidator: vi.fn(async () => ({
        validateDelegation: vi.fn(async () => ({
          ok: false,
          error: { code: 'BAD_SIG', message: 'bad signature' },
        })),
      })),
      createIxoDIDResolver: vi.fn(() => ({})),
    }));

    const req = makeReq({ 'x-ucan-delegation': VALID_DELEGATION_RAW });
    const next = vi.fn() as unknown as NextFunction;

    await mw.use(req, makeRes(), next);

    const err = (next as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as HttpException;
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect((req as unknown as { authData?: unknown }).authData).toBeUndefined();

    vi.doUnmock('@ixo/ucan');
  });
});
