import { SessionManagerService } from '@ixo/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { UserMatrixSqliteSyncService } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';
import { UcanService } from '../ucan/ucan.service.js';
import { FileProcessingService } from './file-processing.service.js';
import { MainAgentGraph } from './forward-refs.js';
import { MessagesService } from './messages.service.js';

describe('MessagesService', () => {
  let service: MessagesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagesService,
        { provide: MainAgentGraph, useValue: {} },
        {
          provide: SessionManagerService,
          useValue: { matrixManger: {} },
        },
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn(),
            getOrThrow: vi.fn(() => ''),
          },
        },
        { provide: UserMatrixSqliteSyncService, useValue: {} },
        { provide: FileProcessingService, useValue: {} },
        { provide: UcanService, useValue: {} },
      ],
    }).compile();

    service = module.get<MessagesService>(MessagesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
