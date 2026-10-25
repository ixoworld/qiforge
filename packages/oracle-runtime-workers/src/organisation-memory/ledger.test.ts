import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { MemoryImportTestDO } from './test-do';
import { parseImportBody, parseStatusBody, sha256 } from './contract';
import fixture from './fixtures/v1.json';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Workers test binding augmentation.
  namespace Cloudflare {
    interface Env {
      MEMORY_IMPORT_TEST: DurableObjectNamespace<MemoryImportTestDO>;
    }
  }
}
const body = await parseImportBody(fixture.rawBody);
const status = parseStatusBody(fixture.rawStatusBody);
describe('durable organisation memory admission', () => {
  it('admits concurrent copies once and returns the saved receipt after reload', async () => {
    const stub = env.MEMORY_IMPORT_TEST.getByName(crypto.randomUUID());
    const [first, duplicate] = await Promise.all([
      stub.submit(body),
      stub.submit(body),
    ]);
    expect(first).toEqual(duplicate);
    expect(await stub.count()).toBe(1);
    await stub.reopen();
    expect(await stub.submit(body)).toEqual(first);
    expect(await stub.status(status)).toEqual(first);
    expect(await stub.count()).toBe(1);
    const stored = await stub.snapshot();
    expect(stored).not.toContain(body.chunks[0]?.content);
    expect(stored).not.toContain('delegation');
  });
  it('conflicts on request id reuse and refuses another status scope', async () => {
    const stub = env.MEMORY_IMPORT_TEST.getByName(crypto.randomUUID());
    await stub.submit(body);
    expect(await stub.conflict({ ...body, visibility: 'public' })).toEqual({
      status: 409,
      code: 'request_digest_conflict',
    });
    expect(
      await stub.deniedStatus({
        ...status,
        domainDid: 'did:ixo:entity:another',
      }),
    ).toEqual({ status: 403, code: 'receipt_scope_mismatch' });
    expect(await stub.count()).toBe(1);
  });
  it('recovers a dispatch marker as unknown and never resumes untouched chunks', async () => {
    const stub = env.MEMORY_IMPORT_TEST.getByName(crypto.randomUUID());
    await stub.submit(body);
    await stub.reopenWithDispatch(status);
    const receipt = await stub.status(status);
    expect(receipt.outcome).toBe('received');
    if (receipt.outcome !== 'received') throw new Error('Missing receipt');
    expect(receipt.receipt.chunks).toEqual([
      {
        id: body.chunks[0]?.id,
        state: 'unknown',
        code: 'dispatch_interrupted',
      },
    ]);
    expect(await stub.submit(body)).toEqual(receipt);
    expect(await stub.count()).toBe(1);
  });
  it('retains truthful partial outcomes and stops after uncertainty', async () => {
    const stub = env.MEMORY_IMPORT_TEST.getByName(crypto.randomUUID());
    const chunk = body.chunks[0];
    if (!chunk) throw new Error('Fixture empty');
    const batch = {
      ...body,
      chunks: [chunk, { ...chunk, id: 'two' }, { ...chunk, id: 'three' }],
    };
    const outcome = await stub.submit(batch, 'partial');
    if (outcome.outcome !== 'received') throw new Error('Missing receipt');
    expect(outcome.receipt.chunks.map((c) => c.state)).toEqual([
      'queued',
      'unknown',
      'not_submitted',
    ]);
    expect(await stub.count()).toBe(2);
    expect(
      await stub.status({
        ...status,
        requestDigest: await sha256(JSON.stringify(batch)),
      }),
    ).toEqual(outcome);
    expect(await stub.submit(batch)).toEqual(outcome);
    expect(await stub.count()).toBe(2);
  });
  it('status not found performs no submission', async () => {
    const stub = env.MEMORY_IMPORT_TEST.getByName(crypto.randomUUID());
    expect(await stub.status(status)).toMatchObject({
      outcome: 'unknown',
      code: 'not_found',
    });
    expect(await stub.count()).toBe(0);
  });
});
