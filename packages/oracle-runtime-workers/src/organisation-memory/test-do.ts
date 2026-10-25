import { DurableObject } from 'cloudflare:workers';
import { ImportLedger } from './ledger';
import {
  ImportError,
  type ImportBody,
  type StatusBody,
  type Receipt,
  sha256,
} from './contract';

export class MemoryImportTestDO extends DurableObject {
  private ledger = new ImportLedger(this.ctx.storage);
  async submit(
    body: ImportBody,
    mode: 'queued' | 'partial' | 'refused' = 'queued',
  ) {
    return this.ledger.submit(
      body,
      await sha256(JSON.stringify(body)),
      async () => ({
        add: async (chunk) => {
          const calls =
            ((await this.ctx.storage.get<number>('calls')) ?? 0) + 1;
          await this.ctx.storage.put('calls', calls);
          if (mode === 'partial' && calls === 2)
            throw new Error('connection lost');
          return mode === 'refused'
            ? { id: chunk.id, state: 'rejected', code: 'upstream_refused' }
            : { id: chunk.id, state: 'queued', queuePosition: calls };
        },
      }),
    );
  }
  async count() {
    return (await this.ctx.storage.get<number>('calls')) ?? 0;
  }
  async snapshot() {
    return JSON.stringify(Object.fromEntries(await this.ctx.storage.list()));
  }
  status(body: StatusBody) {
    return this.ledger.status(body);
  }
  async conflict(body: ImportBody) {
    try {
      await this.submit(body);
      return null;
    } catch (error) {
      if (error instanceof ImportError)
        return { status: error.status, code: error.code };
      throw error;
    }
  }
  async deniedStatus(body: StatusBody) {
    try {
      await this.status(body);
      return null;
    } catch (error) {
      if (error instanceof ImportError)
        return { status: error.status, code: error.code };
      throw error;
    }
  }
  async reopenWithDispatch(body: StatusBody) {
    const key = `memory-import:v1:${body.oracleDid}:${body.userDid}:${body.requestId}`;
    const stored = await this.ctx.storage.get<{ receipt: Receipt }>(key);
    if (!stored) throw new Error('No reservation');
    stored.receipt.chunks = stored.receipt.chunks.map((chunk, index) =>
      index === 0
        ? { id: chunk.id, state: 'dispatching' }
        : { id: chunk.id, state: 'not_submitted' },
    );
    await this.ctx.storage.put(key, stored);
    this.ledger = new ImportLedger(this.ctx.storage);
  }
  reopen() {
    this.ledger = new ImportLedger(this.ctx.storage);
  }
}
