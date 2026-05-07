import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionHistoryProcessor } from '../sessions/session-history-processor.service.js';
import { WsService } from './ws.service.js';

describe('WsService', () => {
  let service: WsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WsService,
        { provide: SessionHistoryProcessor, useValue: {} },
        { provide: ConfigService, useValue: { get: vi.fn() } },
      ],
    }).compile();

    service = module.get<WsService>(WsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
