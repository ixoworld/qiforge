import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SUBSCRIPTION_CREDIT_SINK,
  SUBSCRIPTION_UCAN_PORT,
  SubscriptionMiddleware,
} from './subscription.middleware.js';

vi.mock('@ixo/common', () => ({
  getUserSubscription: vi.fn(),
  getSubscriptionUrlByNetwork: vi.fn(() => 'https://subs.example'),
}));

import { getUserSubscription } from '@ixo/common';

const mockedGetUserSubscription = vi.mocked(getUserSubscription);

interface CacheStub {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

const VALID_UCAN_DELEGATION = {
  issuer: 'did:ixo:abc',
  audience: 'did:ixo:oracle',
  capabilities: [],
};

function buildRequest(
  authData?: Record<string, unknown>,
): Request {
  return {
    originalUrl: '/test',
    authData,
  } as unknown as Request;
}

function buildResponse(): Response {
  return {} as Response;
}

function defaultUcanPort(invocation: string | null = 'ucan-bearer') {
  return {
    hasSigningKey: () => true,
    createServiceInvocation: vi.fn().mockResolvedValue(invocation),
  };
}

async function bootstrapMiddleware({
  cache,
  config,
  ucanPort,
  creditSink,
}: {
  cache: CacheStub;
  config: Record<string, unknown>;
  ucanPort?: { hasSigningKey: () => boolean; createServiceInvocation: ReturnType<typeof vi.fn> };
  creditSink?: {
    setSubscriptionPayload: ReturnType<typeof vi.fn>;
    overrideUserBalance: ReturnType<typeof vi.fn>;
  };
}): Promise<{ middleware: SubscriptionMiddleware; module: TestingModule }> {
  const providers: Parameters<typeof Test.createTestingModule>[0]['providers'] =
    [
      SubscriptionMiddleware,
      { provide: CACHE_MANAGER, useValue: cache },
      {
        provide: ConfigService,
        useValue: {
          get: (key: string, defaultValue?: unknown) =>
            key in config ? config[key] : defaultValue,
          getOrThrow: (key: string) => {
            if (!(key in config)) throw new Error(`missing ${key}`);
            return config[key];
          },
        },
      },
    ];
  if (ucanPort) {
    providers.push({ provide: SUBSCRIPTION_UCAN_PORT, useValue: ucanPort });
  }
  if (creditSink) {
    providers.push({ provide: SUBSCRIPTION_CREDIT_SINK, useValue: creditSink });
  }

  const module = await Test.createTestingModule({ providers }).compile();
  const middleware = module.get(SubscriptionMiddleware);
  return { middleware, module };
}

describe('SubscriptionMiddleware', () => {
  beforeEach(() => {
    mockedGetUserSubscription.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips when authData is missing', async () => {
    const cache = { get: vi.fn(), set: vi.fn() };
    const { middleware } = await bootstrapMiddleware({
      cache,
      config: { NETWORK: 'devnet' },
    });
    const req = buildRequest(undefined);
    const next = vi.fn();
    await middleware.use(req, buildResponse(), next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.subscriptionData).toBeUndefined();
  });

  it('throws 401 when ucanDelegation is missing from authData', async () => {
    const cache = { get: vi.fn(), set: vi.fn() };
    const { middleware } = await bootstrapMiddleware({
      cache,
      config: { NETWORK: 'devnet' },
      ucanPort: defaultUcanPort(),
    });
    const req = buildRequest({ did: 'did:ixo:abc' });
    const next = vi.fn();
    await expect(
      middleware.use(req, buildResponse(), next as NextFunction),
    ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
    expect(next).not.toHaveBeenCalled();
  });

  it('serves cached subscription and calls next', async () => {
    const cache = {
      get: vi.fn().mockResolvedValue({
        status: 'active',
        totalCredits: 100,
        currentPlan: 'plan',
        currentPlanName: 'Plan',
        planCredits: 100,
        adminAddress: '',
        claimCollections: {},
      }),
      set: vi.fn(),
    };
    const { middleware } = await bootstrapMiddleware({
      cache,
      config: { NETWORK: 'devnet' },
      ucanPort: defaultUcanPort(),
    });
    const req = buildRequest({
      did: 'did:ixo:abc',
      ucanDelegation: VALID_UCAN_DELEGATION,
    });
    const next = vi.fn();
    await middleware.use(req, buildResponse(), next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.subscriptionData?.status).toBe('active');
    expect(mockedGetUserSubscription).not.toHaveBeenCalled();
  });

  it('throws 402 when status is inactive', async () => {
    const cache = {
      get: vi.fn().mockResolvedValue({
        status: 'inactive',
        totalCredits: 100,
        currentPlan: 'plan',
        currentPlanName: 'Plan',
        planCredits: 100,
        adminAddress: '',
        claimCollections: {},
      }),
      set: vi.fn(),
    };
    const { middleware } = await bootstrapMiddleware({
      cache,
      config: { NETWORK: 'devnet' },
      ucanPort: defaultUcanPort(),
    });
    const req = buildRequest({
      did: 'did:ixo:abc',
      ucanDelegation: VALID_UCAN_DELEGATION,
    });
    const next = vi.fn();
    await expect(
      middleware.use(req, buildResponse(), next as NextFunction),
    ).rejects.toMatchObject({
      status: HttpStatus.PAYMENT_REQUIRED,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('throws 402 when totalCredits <= 10', async () => {
    const cache = {
      get: vi.fn().mockResolvedValue({
        status: 'active',
        totalCredits: 10,
        currentPlan: 'plan',
        currentPlanName: 'Plan',
        planCredits: 10,
        adminAddress: '',
        claimCollections: {},
      }),
      set: vi.fn(),
    };
    const { middleware } = await bootstrapMiddleware({
      cache,
      config: { NETWORK: 'devnet' },
      ucanPort: defaultUcanPort(),
    });
    const req = buildRequest({
      did: 'did:ixo:abc',
      ucanDelegation: VALID_UCAN_DELEGATION,
    });
    const next = vi.fn();
    await expect(
      middleware.use(req, buildResponse(), next as NextFunction),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('bypasses credit check when DISABLE_CREDITS=true', async () => {
    const cache = {
      get: vi.fn().mockResolvedValue({
        status: 'inactive',
        totalCredits: 0,
        currentPlan: 'plan',
        currentPlanName: 'Plan',
        planCredits: 0,
        adminAddress: '',
        claimCollections: {},
      }),
      set: vi.fn(),
    };
    const { middleware } = await bootstrapMiddleware({
      cache,
      config: { NETWORK: 'devnet', DISABLE_CREDITS: true },
      ucanPort: defaultUcanPort(),
    });
    const req = buildRequest({
      did: 'did:ixo:abc',
      ucanDelegation: VALID_UCAN_DELEGATION,
    });
    const next = vi.fn();
    await middleware.use(req, buildResponse(), next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('throws 401 when no UCAN signing key is configured', async () => {
    const cache = { get: vi.fn().mockResolvedValue(undefined), set: vi.fn() };
    const { middleware } = await bootstrapMiddleware({
      cache,
      config: { NETWORK: 'devnet' },
    });
    const req = buildRequest({
      did: 'did:ixo:abc',
      ucanDelegation: VALID_UCAN_DELEGATION,
    });
    const next = vi.fn();
    await expect(
      middleware.use(req, buildResponse(), next as NextFunction),
    ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
    expect(next).not.toHaveBeenCalled();
  });

  it('throws 402 when API returns null subscription', async () => {
    const cache = { get: vi.fn().mockResolvedValue(undefined), set: vi.fn() };
    mockedGetUserSubscription.mockResolvedValue(null);

    const { middleware } = await bootstrapMiddleware({
      cache,
      config: { NETWORK: 'devnet' },
      ucanPort: defaultUcanPort(),
    });
    const req = buildRequest({
      did: 'did:ixo:abc',
      ucanDelegation: VALID_UCAN_DELEGATION,
    });
    const next = vi.fn();
    await expect(
      middleware.use(req, buildResponse(), next as NextFunction),
    ).rejects.toMatchObject({ status: HttpStatus.PAYMENT_REQUIRED });
  });

  it('uses UCAN invocation, caches, and syncs credit sink when present', async () => {
    const cache = { get: vi.fn().mockResolvedValue(undefined), set: vi.fn() };
    const subscription = {
      status: 'active',
      totalCredits: 50,
      currentPlan: 'plan',
      currentPlanName: 'Plan',
      planCredits: 50,
      adminAddress: '',
      claimCollections: {},
    };
    mockedGetUserSubscription.mockResolvedValue(subscription as never);
    const ucan = defaultUcanPort('ucan-bearer');

    const sink = {
      setSubscriptionPayload: vi.fn().mockResolvedValue(undefined),
      overrideUserBalance: vi.fn().mockResolvedValue(undefined),
    };

    const { middleware } = await bootstrapMiddleware({
      cache,
      config: { NETWORK: 'devnet' },
      ucanPort: ucan,
      creditSink: sink,
    });
    const req = buildRequest({
      did: 'did:ixo:abc',
      ucanDelegation: VALID_UCAN_DELEGATION,
    });
    const next = vi.fn();
    await middleware.use(req, buildResponse(), next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
    expect(ucan.createServiceInvocation).toHaveBeenCalled();
    expect(mockedGetUserSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ authType: 'ucan', bearerToken: 'ucan-bearer' }),
    );
    expect(cache.set).toHaveBeenCalled();
    expect(sink.setSubscriptionPayload).toHaveBeenCalledWith(
      'did:ixo:abc',
      subscription,
    );
    expect(sink.overrideUserBalance).toHaveBeenCalledWith('did:ixo:abc', 50);
  });

  it('throws 401 when invocation minting returns null', async () => {
    const cache = { get: vi.fn().mockResolvedValue(undefined), set: vi.fn() };
    const ucan = defaultUcanPort(null);

    const { middleware } = await bootstrapMiddleware({
      cache,
      config: { NETWORK: 'devnet' },
      ucanPort: ucan,
    });
    const req = buildRequest({
      did: 'did:ixo:abc',
      ucanDelegation: VALID_UCAN_DELEGATION,
    });
    const next = vi.fn();
    await expect(
      middleware.use(req, buildResponse(), next as NextFunction),
    ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
  });
});
