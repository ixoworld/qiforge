export { VfsPlugin, type VfsConfig, type VfsPluginOptions } from './vfs.plugin';
export {
  buildClient,
  createVfsTools,
  invalidArgs,
  validatePath,
  type CreateVfsToolsDeps,
} from './vfs-tools';
export {
  createVfsSandboxTools,
  type CreateVfsSandboxToolsDeps,
} from './vfs-sandbox-tools';
export { vfsBearer, type VfsBearerResult } from './vfs-auth';
export {
  VfsClient,
  type VfsBatchItemResult,
  type VfsClientOptions,
  type VfsContentBytes,
  type VfsEditResult,
  type VfsFileStat,
  type VfsGlobMatch,
  type VfsMintFn,
  type VfsPublicResult,
  type VfsReadWindow,
  type VfsSearchHit,
  type VfsSearchResult,
  type VfsTreeEntry,
} from './vfs-client';
export { isTextMime, readForAgent } from './vfs-content';
export {
  isAlreadyExistsConflict,
  isWriteConflict,
  mapVfsError,
  NO_ACCESS_MESSAGE,
  noAccessMessage,
  VfsAuthError,
  VfsHttpError,
  type VfsAbility,
  type VfsAuthErrorKind,
} from './vfs-errors';
