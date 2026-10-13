/**
 * The editor write path against an in-process homeserver: a write's outcome
 * comes from the provider manager's bounded flush, so a forbidden write is
 * `needs_access`, a refused one is `error`, an unacknowledged one is
 * `write_not_saved`, and a delivered one succeeds.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { PluginTool } from '../../plugin-api/types';
import { TestHomeserver } from '../flows/test-homeserver';
import { markdownToBlockContainers } from './blocknote-bridge';
import { sharedDocumentSource } from './content-session';
import { createContentTools } from './content-tools';
import { appendBlocks, readDocumentBlocks } from './document-model';
import type { AppConfig } from './provider';

const ROOM = '!doc:test.example';
const SEND_PATH = '/send/matrix-crdt.doc_update';
const RETRY = { maxAttempts: 3, budgetMs: 5_000, baseBackoffMs: 20 };

function appConfig(): AppConfig {
  return {
    matrix: {
      baseUrl: 'https://hs.test.example',
      accessToken: 'test-token',
      userId: '@oracle:test.example',
      room: { type: 'id', value: ROOM },
      initialSyncTimeoutMs: 5_000,
    },
    provider: {
      docName: 'document',
      enableAwareness: false,
      retryAttempts: 1,
      retryDelayMs: 10,
      flushInterval: 10,
      retryIfForbiddenInterval: 1_000,
      maxForbiddenRetries: 1,
      writeRetry: RETRY,
    },
    blocknote: { mutableAttributeKeys: [] },
  };
}

async function seededHomeserver(): Promise<TestHomeserver> {
  const hs = new TestHomeserver();
  const seed = new Y.Doc();
  const containers = await markdownToBlockContainers('existing paragraph');
  seed.transact(() => appendBlocks(seed, containers));
  hs.seedDoc(ROOM, seed);
  return hs;
}

/** One shared session over the homeserver, as `call_editor_agent` opens it. */
function openTools(hs: TestHomeserver) {
  const documents = sharedDocumentSource({
    matrixClient: hs.client(),
    appConfig: appConfig(),
  });
  const tools = new Map<string, PluginTool>(
    createContentTools({ documents }).map((t) => [t.name, t]),
  );
  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return JSON.parse(String(await tool.handler(args, makeRuntimeContext())));
  };
  return { call, close: () => documents.close() };
}

const INSERT = { markdown: 'new paragraph' };

describe('applyDocumentEdit outcome from the provider flush', () => {
  it('reports a delivered write as success and the room holds it', async () => {
    const hs = await seededHomeserver();
    const { call, close } = openTools(hs);

    expect(await call('insert_content', INSERT)).toMatchObject({
      ok: true,
      inserted: 1,
    });
    expect(hs.count('PUT', SEND_PATH)).toBe(1);
    expect(readDocumentBlocks(hs.docOf(ROOM)).map((b) => b.text)).toEqual([
      'existing paragraph',
      'new paragraph',
    ]);
    await close();
  });

  it('reports a forbidden write as needs_access', async () => {
    const hs = await seededHomeserver();
    hs.sendScript = [{ status: 403, errcode: 'M_FORBIDDEN' }];
    const { call, close } = openTools(hs);

    expect(await call('insert_content', INSERT)).toMatchObject({
      ok: false,
      code: 'needs_access',
    });
    await close();
  });

  it('reports a write the homeserver keeps failing as write_not_saved within the retry budget', async () => {
    const hs = await seededHomeserver();
    hs.sendScript = Array.from({ length: 50 }, () => ({
      status: 500,
      errcode: 'M_UNKNOWN',
    }));
    const { call, close } = openTools(hs);

    const started = Date.now();
    const result = await call('insert_content', INSERT);
    expect(result).toMatchObject({ ok: false, code: 'write_not_saved' });
    expect(Date.now() - started).toBeLessThan(RETRY.budgetMs);
    expect(hs.count('PUT', SEND_PATH)).toBe(RETRY.maxAttempts);

    // The session refuses further writes with the same answer, without sending.
    expect(await call('insert_content', INSERT)).toMatchObject({
      ok: false,
      code: 'write_not_saved',
    });
    await close();
    expect(hs.count('PUT', SEND_PATH)).toBe(RETRY.maxAttempts);
  });

  it('reports an oversized write as a definite refusal, not an uncertain write, after one send', async () => {
    const hs = await seededHomeserver();
    hs.sendScript = [{ status: 413, errcode: 'M_TOO_LARGE' }];
    const { call, close } = openTools(hs);

    const started = Date.now();
    const result = await call('insert_content', INSERT);
    expect(result).toMatchObject({ ok: false, code: 'error' });
    expect(JSON.stringify(result)).toContain('was NOT saved');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(hs.count('PUT', SEND_PATH)).toBe(1);
    await close();
  });
});
