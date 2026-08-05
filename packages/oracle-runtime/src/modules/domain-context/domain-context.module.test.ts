import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { mockDomain } from '../../testing/mocks.js';
import { DomainContextModule } from './domain-context.module.js';
import {
  DOMAIN_CONTEXT,
  DomainContextService,
} from './domain-context.service.js';

/** A service in an unrelated module — the point of `@Global` is that this works. */
@Injectable()
class SomeUnrelatedService {
  constructor(readonly domain: DomainContextService) {}
}

@Module({ providers: [SomeUnrelatedService] })
class UnrelatedModule {}

describe('DomainContextModule', () => {
  it('serves the constitution it was registered with', async () => {
    const context = mockDomain({ subject: 'did:ixo:entity:under-test' });
    const moduleRef = await Test.createTestingModule({
      imports: [DomainContextModule.register(context)],
    }).compile();

    expect(moduleRef.get(DomainContextService).get()).toBe(context);
    expect(moduleRef.get(DOMAIN_CONTEXT)).toBe(context);
  });

  it('reaches modules that never imported it', async () => {
    const context = mockDomain();
    const moduleRef = await Test.createTestingModule({
      imports: [DomainContextModule.register(context), UnrelatedModule],
    }).compile();

    expect(moduleRef.get(SomeUnrelatedService).domain.get()).toBe(context);
  });

  it('hands out a constitution the holder cannot alter', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        DomainContextModule.register(mockDomain({ baseline: ['pay'] })),
      ],
    }).compile();

    const served = moduleRef.get(DomainContextService).get();
    expect(Object.isFrozen(served)).toBe(true);
    expect(Object.isFrozen(served.policy.baseline)).toBe(true);
  });
});
