import {
  ImportError,
  type ImportBody,
  type ImportChunk,
  type ImportResult,
  type StatusBody,
  type Receipt,
  type ChunkReceipt,
} from './contract';

export interface MetadataTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
export interface MetadataStorage extends MetadataTransaction {
  transaction<T>(closure: (txn: MetadataTransaction) => Promise<T>): Promise<T>;
}
interface RecordMetadata {
  receipt: Receipt;
  appId: string;
  resourceId: string;
  hashes: { id: string; contentSha256: string; sourceSha256: string }[];
}
/** A transport's verdict; `not_submitted` means nothing left the Worker. */
export type ChunkOutcome = Exclude<ChunkReceipt, { state: 'dispatching' }>;
export interface ImportTransport {
  add(
    chunk: ImportChunk,
    visibility: ImportBody['visibility'],
  ): Promise<ChunkOutcome>;
}
type PrepareTransport = () => Promise<ImportTransport>;
const keyOf = (body: ImportBody | StatusBody) =>
  `memory-import:v1:${body.oracleDid}:${body.userDid}:${body.requestId}`;

function checkScope(
  record: RecordMetadata,
  body: ImportBody | StatusBody,
  digest: string,
): void {
  if (record.receipt.requestDigest !== digest)
    throw new ImportError(409, 'request_digest_conflict');
  if (
    record.receipt.domainDid !== body.domainDid ||
    record.receipt.network !== body.network ||
    record.receipt.oracleEntityDid !== body.oracleEntityDid ||
    record.receipt.oracleDid !== body.oracleDid ||
    record.receipt.userDid !== body.userDid ||
    record.appId !== body.appId ||
    record.resourceId !== body.resourceId
  )
    throw new ImportError(403, 'receipt_scope_mismatch');
}
function result(receipt: Receipt): ImportResult {
  return {
    version: 1,
    requestId: receipt.requestId,
    requestDigest: receipt.requestDigest,
    outcome: 'received',
    receipt,
  };
}

export class ImportLedger {
  private readonly running = new Map<
    string,
    { digest: string; work: Promise<ImportResult> }
  >();
  constructor(private readonly storage: MetadataStorage) {}

  submit(
    body: ImportBody,
    digest: string,
    prepare: PrepareTransport,
  ): Promise<ImportResult> {
    const key = keyOf(body);
    const existing = this.running.get(key);
    if (existing) {
      if (existing.digest !== digest)
        return Promise.reject(new ImportError(409, 'request_digest_conflict'));
      return existing.work;
    }
    const work = this.admit(body, digest, prepare).finally(() => {
      this.running.delete(key);
    });
    this.running.set(key, { digest, work });
    return work;
  }

  async status(body: StatusBody): Promise<ImportResult> {
    const running = this.running.get(keyOf(body));
    if (running) {
      if (running.digest !== body.requestDigest)
        throw new ImportError(409, 'request_digest_conflict');
      const stored = await this.storage.get<RecordMetadata>(keyOf(body));
      if (stored) {
        checkScope(stored, body, body.requestDigest);
        return result(stored.receipt);
      }
    }
    const found = await this.storage.transaction(async (txn) => {
      const record = await txn.get<RecordMetadata>(keyOf(body));
      if (!record) return undefined;
      checkScope(record, body, body.requestDigest);
      if (!this.running.has(keyOf(body)))
        await this.recover(txn, keyOf(body), record);
      return record;
    });
    return found
      ? result(found.receipt)
      : {
          version: 1,
          requestId: body.requestId,
          requestDigest: body.requestDigest,
          outcome: 'unknown',
          code: 'not_found',
        };
  }

  /**
   * Settles a record whose writer is gone (the object restarted). A codeless
   * `not_submitted` chunk means "not reached yet" only while a writer runs;
   * afterwards it can never be sent, so it gets a terminal code.
   */
  private async recover(
    txn: MetadataTransaction,
    key: string,
    record: RecordMetadata,
  ): Promise<void> {
    if (
      !record.receipt.chunks.some(
        (chunk) =>
          chunk.state === 'dispatching' ||
          (chunk.state === 'not_submitted' && !chunk.code),
      )
    )
      return;
    record.receipt.chunks = record.receipt.chunks.map((chunk) =>
      chunk.state === 'dispatching'
        ? { id: chunk.id, state: 'unknown', code: 'dispatch_interrupted' }
        : chunk.state === 'not_submitted' && !chunk.code
          ? { id: chunk.id, state: 'not_submitted', code: 'writer_interrupted' }
          : chunk,
    );
    await txn.put(key, record);
  }

  private async admit(
    body: ImportBody,
    digest: string,
    prepare: PrepareTransport,
  ): Promise<ImportResult> {
    const key = keyOf(body);
    const admission = await this.storage.transaction(async (txn) => {
      const existing = await txn.get<RecordMetadata>(key);
      if (existing) {
        checkScope(existing, body, digest);
        await this.recover(txn, key, existing);
        return { created: false, record: existing };
      }
      const record: RecordMetadata = {
        appId: body.appId,
        resourceId: body.resourceId,
        hashes: body.chunks.map(({ id, contentSha256, sourceSha256 }) => ({
          id,
          contentSha256,
          sourceSha256,
        })),
        receipt: {
          version: 1,
          requestId: body.requestId,
          requestDigest: digest,
          domainDid: body.domainDid,
          oracleEntityDid: body.oracleEntityDid,
          oracleDid: body.oracleDid,
          network: body.network,
          userDid: body.userDid,
          chunks: body.chunks.map(({ id }) => ({ id, state: 'not_submitted' })),
        },
      };
      await txn.put(key, record);
      return { created: true, record };
    });
    const record = admission.record;
    if (!admission.created) return result(record.receipt);
    let transport: ImportTransport;
    try {
      transport = await prepare();
    } catch (error) {
      const code =
        error instanceof ImportError ? error.code : 'preparation_failed';
      record.receipt.chunks = record.receipt.chunks.map(({ id }) => ({
        id,
        state: 'not_submitted',
        code,
      }));
      await this.storage.put(key, record);
      return result(record.receipt);
    }
    for (const chunk of body.chunks) {
      await this.saveChunk(key, record, { id: chunk.id, state: 'dispatching' });
      let outcome: ChunkOutcome;
      try {
        outcome = await transport.add(chunk, body.visibility);
      } catch {
        outcome = {
          id: chunk.id,
          state: 'unknown',
          code: 'upstream_uncertain',
        };
      }
      await this.saveChunk(key, record, outcome);
      if (outcome.state === 'unknown' || outcome.state === 'not_submitted')
        break;
    }
    // Chunks the stopped batch never reached are final, not pending.
    if (
      record.receipt.chunks.some(
        (chunk) => chunk.state === 'not_submitted' && !chunk.code,
      )
    ) {
      record.receipt.chunks = record.receipt.chunks.map((chunk) =>
        chunk.state === 'not_submitted' && !chunk.code
          ? { id: chunk.id, state: 'not_submitted', code: 'batch_stopped' }
          : chunk,
      );
      await this.storage.put(key, record);
    }
    return result(record.receipt);
  }

  private async saveChunk(
    key: string,
    record: RecordMetadata,
    chunk: ChunkReceipt,
  ): Promise<void> {
    record.receipt.chunks = record.receipt.chunks.map((current) =>
      current.id === chunk.id ? chunk : current,
    );
    await this.storage.put(key, record);
  }
}
