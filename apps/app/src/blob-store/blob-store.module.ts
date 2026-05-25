import { Global, Module } from '@nestjs/common';
import { BlobStoreService } from './blob-store.service';

/**
 * Global module exposing BlobStoreService.
 *
 * The service uses the app-wide CacheModule (already registered globally
 * in AppModule), so this module just declares the service as a global
 * provider — no extra imports needed.
 */
@Global()
@Module({
  providers: [BlobStoreService],
  exports: [BlobStoreService],
})
export class BlobStoreModule {}
