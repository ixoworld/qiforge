import { SessionManagerService } from '@ixo/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { UserMatrixSqliteSyncService } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';
import { BatchInvoker } from './batch-invoker.js';
import { FileProcessingService } from './file-processing.service.js';
import { MatrixListenerBridge } from './matrix-listener-bridge.js';
import { MessagesService } from './messages.service.js';
import { PostMessageSyncer } from './post-message-syncer.js';
import { RequestPreparer } from './request-preparer.js';
import { SseStreamRunner } from './sse-stream-runner.js';

describe('MessagesService', () => {
  let service: MessagesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagesService,
        { provide: RequestPreparer, useValue: {} },
        { provide: SseStreamRunner, useValue: {} },
        { provide: BatchInvoker, useValue: {} },
        { provide: FileProcessingService, useValue: {} },
        {
          provide: UserMatrixSqliteSyncService,
          useValue: { markUserActive: vi.fn(), markUserInactive: vi.fn() },
        },
        { provide: PostMessageSyncer, useValue: {} },
        {
          provide: MatrixListenerBridge,
          useValue: { setDeliverHandler: vi.fn() },
        },
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
      ],
    }).compile();

    service = module.get<MessagesService>(MessagesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
