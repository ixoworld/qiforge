import { SessionManagerService } from '@ixo/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { MainAgentGraph } from 'src/graph';
import { UcanService } from 'src/ucan/ucan.service';
import { UserMatrixSqliteSyncService } from 'src/user-matrix-sqlite-sync-service/user-matrix-sqlite-sync-service.service';
import { ChannelMemoryService } from 'src/channel-memory/channel-memory.service';
import { FileProcessingService } from './file-processing.service';
import { AnonymousFeedbackService } from './feedback/anonymous-feedback.service';
import { MessagesService } from './messages.service';

describe('MessagesService', () => {
  let service: MessagesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagesService,
        { provide: MainAgentGraph, useValue: {} },
        { provide: SessionManagerService, useValue: { matrixManger: {} } },
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn(),
            getOrThrow: vi.fn((key: string) => {
              if (key === 'MATRIX_BASE_URL') return 'https://matrix.example';
              if (key === 'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN') return 'token';
              if (key === 'MATRIX_ORACLE_ADMIN_USER_ID')
                return '@agent:example';
              throw new Error(`Unexpected config key ${key}`);
            }),
          },
        },
        { provide: UserMatrixSqliteSyncService, useValue: {} },
        { provide: FileProcessingService, useValue: {} },
        { provide: ChannelMemoryService, useValue: {} },
        { provide: AnonymousFeedbackService, useValue: { isEnabled: vi.fn() } },
        { provide: UcanService, useValue: {} },
      ],
    }).compile();

    service = module.get<MessagesService>(MessagesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
