export { VfsPlugin, resolveVfsBaseUrls, type VfsConfig } from './vfs.plugin.js';
export { createVfsTools, type CreateVfsToolsDeps } from './vfs-tools.js';
export {
  createVfsSandboxTools,
  type CreateVfsSandboxToolsDeps,
} from './vfs-sandbox-tools.js';
export { vfsBearer, type VfsBearerResult } from './vfs-auth.js';
export {
  VfsClient,
  type VfsClientOptions,
  type VfsMintFn,
  type VfsFileStat,
  type VfsSearchHit,
  type VfsSearchResult,
  type VfsGlobMatch,
  type VfsTreeEntry,
  type VfsReadWindow,
  type VfsContentBytes,
  type VfsBatchItemResult,
  type VfsPublicResult,
  type VfsEditResult,
} from './vfs-client.js';
export { readForAgent } from './vfs-content.js';
export {
  VfsHttpError,
  VfsAuthError,
  mapVfsError,
  isWriteConflict,
  isAlreadyExistsConflict,
  NO_ACCESS_MESSAGE,
  type VfsAbility,
  type VfsAuthErrorKind,
} from './vfs-errors.js';
