import { z } from 'zod';

export const IMPORT_LIMITS = {
  maxChunks: 25,
  maxChunkBytes: 12_000,
  maxBodyBytes: 262_144,
};
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const EntityDid = z.string().regex(/^did:ixo:entity:[a-f0-9]{32}$/);
const AccountDid = z
  .string()
  .regex(/^did:ixo:ixo1[a-z0-9]+$/)
  .max(100);
export const ImportScope = z.object({
  version: z.literal(1),
  requestId: z.uuid(),
  domainDid: EntityDid,
  oracleEntityDid: EntityDid,
  oracleDid: AccountDid,
  network: z.enum(['mainnet', 'testnet', 'devnet']),
  userDid: AccountDid,
  appId: z.literal('organisation-memory'),
  resourceId: z.string().min(1).max(1024),
});
export const ImportChunkSchema = z.strictObject({
  id: z.string().min(1).max(160),
  sourceName: z.string().min(1).max(200),
  sourceSha256: Hash,
  locator: z.string().min(1).max(200),
  content: z
    .string()
    .min(1)
    .refine(
      (v) => new TextEncoder().encode(v).length <= IMPORT_LIMITS.maxChunkBytes,
    ),
  contentSha256: Hash,
});
export const ImportBodySchema = ImportScope.extend({
  visibility: z.enum(['private', 'public']),
  chunks: z
    .array(ImportChunkSchema)
    .min(1)
    .max(IMPORT_LIMITS.maxChunks)
    .refine(
      (chunks) => new Set(chunks.map((c) => c.id)).size === chunks.length,
    ),
}).strict();
export const StatusBodySchema = ImportScope.extend({
  requestDigest: Hash,
}).strict();
export type ImportBody = z.infer<typeof ImportBodySchema>;
export type ImportChunk = z.infer<typeof ImportChunkSchema>;
export type StatusBody = z.infer<typeof StatusBodySchema>;
export type Operation = 'submit' | 'status';
export type ChunkReceipt = { id: string } & (
  | { state: 'queued'; queuePosition: number }
  | { state: 'dispatching' }
  | { state: 'unknown'; code: string }
  | { state: 'rejected'; code: string }
  | { state: 'not_submitted'; code?: string }
);
export type Receipt = Pick<
  StatusBody,
  | 'version'
  | 'requestId'
  | 'requestDigest'
  | 'domainDid'
  | 'oracleEntityDid'
  | 'oracleDid'
  | 'network'
  | 'userDid'
> & { chunks: ChunkReceipt[] };
export type ImportResult = {
  version: 1;
  requestId: string;
  requestDigest: string;
} & (
  | { outcome: 'received'; receipt: Receipt }
  | { outcome: 'unknown'; code: string }
);
export type ImportCommand =
  | {
      operation: 'submit';
      body: ImportBody;
      requestDigest: string;
      delegation: string;
    }
  | { operation: 'status'; body: StatusBody; requestDigest: string };

export class ImportError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 503,
    public readonly code: string,
  ) {
    super(code);
  }
}
/** The deployment's network, with the env schema's default. */
export function importNetwork(env: { NETWORK?: string }): string {
  return env.NETWORK ?? 'mainnet';
}
export async function sha256(raw: string | Uint8Array): Promise<string> {
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export async function parseImportBody(raw: string): Promise<ImportBody> {
  const body = parseBody(raw, ImportBodySchema);
  for (const chunk of body.chunks) {
    if ((await sha256(chunk.content)) !== chunk.contentSha256)
      throw new ImportError(400, 'content_hash_mismatch');
  }
  return body;
}
export function parseStatusBody(raw: string): StatusBody {
  return parseBody(raw, StatusBodySchema);
}
function parseBody<T>(raw: string, schema: z.ZodType<T>): T {
  if (new TextEncoder().encode(raw).length > IMPORT_LIMITS.maxBodyBytes)
    throw new ImportError(413, 'body_too_large');
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    throw new ImportError(400, 'invalid_body');
  }
}
export async function boundFacts(
  operation: Operation,
  raw: string,
  body: ImportBody | StatusBody,
) {
  const bodyDigest = await sha256(raw);
  return {
    kind: 'ixo.organisation-memory.invocation',
    version: 1,
    operation,
    bodyDigest,
    requestId: body.requestId,
    requestDigest: 'requestDigest' in body ? body.requestDigest : bodyDigest,
    domainDid: body.domainDid,
    oracleEntityDid: body.oracleEntityDid,
    oracleDid: body.oracleDid,
    network: body.network,
    userDid: body.userDid,
    path: operation === 'submit' ? '/memory/imports' : '/memory/imports/status',
  };
}
