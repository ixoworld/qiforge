import { Module } from '@nestjs/common';
import { UcanService } from '../../modules/ucan/ucan.service.js';
import { UserMatrixSqliteSyncService } from './user-matrix-sqlite-sync-service.service.js';

@Module({
  providers: [
    {
      provide: UserMatrixSqliteSyncService,
      useFactory: (ucan: UcanService) => {
        const service = UserMatrixSqliteSyncService.getInstance();
        service.attachUcanService(ucan);
        return service;
      },
      inject: [UcanService],
    },
  ],
  exports: [UserMatrixSqliteSyncService],
})
export class CheckpointStorageSyncModule {}
