import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  TestHomeserver,
  watchUnhandledRejections,
} from '../flows/test-homeserver';
import {
  MatrixProviderManager,
  RoomNotAccessibleError,
  type AppConfig,
  type DocWriteRetryOptions,
} from './provider';

const ROOM = '!doc:test.example';

function config(
  overrides: {
    retryAttempts?: number;
    initialSyncTimeoutMs?: number;
    writeRetry?: DocWriteRetryOptions;
  } = {},
): AppConfig {
  return {
    matrix: {
      baseUrl: 'https://hs.test.example',
      accessToken: 'test-token',
      userId: '@oracle:test.example',
      room: { type: 'id', value: ROOM },
      initialSyncTimeoutMs: overrides.initialSyncTimeoutMs ?? 5_000,
    },
    provider: {
      docName: 'document',
      enableAwareness: false,
      retryAttempts: overrides.retryAttempts ?? 3,
      retryDelayMs: 10,
      flushInterval: 10,
      retryIfForbiddenInterval: 1_000,
      maxForbiddenRetries: 1,
      writeRetry: overrides.writeRetry ?? {
        maxAttempts: 3,
        budgetMs: 5_000,
        baseBackoffMs: 20,
      },
    },
    blocknote: { mutableAttributeKeys: [] },
  };
}

function seededHomeserver(): TestHomeserver {
  const hs = new TestHomeserver();
  const seed = new Y.Doc();
  seed.getMap('m').set('seed', 'value');
  hs.seedDoc(ROOM, seed);
  return hs;
}

async function openManager(hs: TestHomeserver, cfg = config()) {
  const manager = new MatrixProviderManager(hs.client(), cfg);
  const { doc } = await manager.init();
  return { manager, doc };
}

describe('MatrixProviderManager: loading', () => {
  it('loads the room history into the doc and closes the long-poll on dispose', async () => {
    const hs = seededHomeserver();
    const { manager, doc } = await openManager(hs);
    expect(doc.getMap('m').get('seed')).toBe('value');
    expect(hs.openPolls).toBe(1);

    await manager.dispose();
    expect(hs.openPolls).toBe(0);
  });

  it('rejects within the retry budget when the history walk keeps failing', async () => {
    const hs = seededHomeserver();
    hs.messagesFailure = { status: 502, errcode: 'M_UNKNOWN' };
    const manager = new MatrixProviderManager(
      hs.client(),
      config({ retryAttempts: 3 }),
    );
    const started = Date.now();
    await expect(manager.init()).rejects.toThrow();
    // Every attempt ran (a hung cleanup would have stopped after the first).
    expect(hs.count('GET', '/messages')).toBe(3);
    expect(Date.now() - started).toBeLessThan(5_000);
    await manager.dispose();
  });

  it('does not retry a load the homeserver refused', async () => {
    const hs = seededHomeserver();
    hs.messagesFailure = { status: 403, errcode: 'M_FORBIDDEN' };
    const manager = new MatrixProviderManager(
      hs.client(),
      config({ retryAttempts: 3 }),
    );
    await expect(manager.init()).rejects.toThrow();
    expect(hs.count('GET', '/messages')).toBe(1);
    await manager.dispose();
  });
});

describe('MatrixProviderManager: abandoned loads', () => {
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it('a load past its deadline rejects, and its late completion raises nothing', async () => {
    const hs = seededHomeserver();
    hs.messagesDelays = [400];
    const rejections = watchUnhandledRejections();
    const manager = new MatrixProviderManager(
      hs.client(),
      config({ retryAttempts: 1, initialSyncTimeoutMs: 100 }),
    );

    await expect(manager.init()).rejects.toThrow(/did not load within 100ms/);
    // Let the abandoned history walk finish and find itself superseded.
    await sleep(600);
    await manager.dispose();
    await sleep(50);

    rejections.stop();
    expect(rejections.reasons).toEqual([]);
    expect(hs.openPolls).toBe(0);
  });

  it('a superseded attempt finishing after the retry succeeded raises nothing', async () => {
    const hs = seededHomeserver();
    hs.messagesDelays = [400];
    const rejections = watchUnhandledRejections();
    const manager = new MatrixProviderManager(
      hs.client(),
      config({ retryAttempts: 2, initialSyncTimeoutMs: 150 }),
    );

    const { doc } = await manager.init();
    expect(doc.getMap('m').get('seed')).toBe('value');
    await sleep(600);
    // Only the winning attempt's long-poll is still open.
    expect(hs.openPolls).toBe(1);
    await manager.dispose();
    await sleep(50);

    rejections.stop();
    expect(rejections.reasons).toEqual([]);
    expect(hs.openPolls).toBe(0);
  });

  it('disposing during a load rejects the load and raises nothing', async () => {
    const hs = seededHomeserver();
    hs.messagesDelays = [300];
    const rejections = watchUnhandledRejections();
    const manager = new MatrixProviderManager(hs.client(), config());

    const loading = manager.init();
    await sleep(50);
    await manager.dispose();
    await expect(loading).rejects.toThrow();
    await sleep(400);

    rejections.stop();
    expect(rejections.reasons).toEqual([]);
    expect(hs.openPolls).toBe(0);
  });
});

describe('MatrixProviderManager: room join', () => {
  it('joins a room once per client, not on every load', async () => {
    const hs = seededHomeserver();
    const client = hs.client();
    for (let i = 0; i < 3; i += 1) {
      const manager = new MatrixProviderManager(client, config());
      await manager.init();
      await manager.dispose();
    }
    expect(hs.count('POST', '/join')).toBe(1);
    expect(hs.count('GET', '/messages')).toBe(3);
  });

  it('shares one join between loads within the join window', async () => {
    const hs = seededHomeserver();
    const client = hs.client();
    let now = 1_000_000;
    const clock = { now: () => now };
    for (const at of [0, 30_000, 59_000]) {
      now = 1_000_000 + at;
      const manager = new MatrixProviderManager(client, config(), clock);
      await manager.init();
      await manager.dispose();
    }
    expect(hs.count('POST', '/join')).toBe(1);
  });

  it('joins again once the join window has passed', async () => {
    const hs = seededHomeserver();
    const client = hs.client();
    let now = 1_000_000;
    const clock = { now: () => now };
    const first = new MatrixProviderManager(client, config(), clock);
    await first.init();
    await first.dispose();

    now += 61_000;
    const second = new MatrixProviderManager(client, config(), clock);
    await second.init();
    await second.dispose();
    expect(hs.count('POST', '/join')).toBe(2);
  });

  it('after a forbidden write the next load joins again and fails clearly when refused', async () => {
    const hs = seededHomeserver();
    const client = hs.client();
    const clock = { now: () => 1_000_000 };
    const writer = new MatrixProviderManager(client, config(), clock);
    const { doc } = await writer.init();
    hs.sendScript = [{ status: 403, errcode: 'M_FORBIDDEN' }];
    doc.getMap('m').set('written', 'yes');
    expect(await writer.flush()).toMatchObject({ kind: 'forbidden' });
    await writer.dispose();

    // The oracle was removed: a join is refused, while history up to the
    // removal would still be readable.
    hs.joinFailure = { status: 403, errcode: 'M_FORBIDDEN' };
    const reader = new MatrixProviderManager(client, config(), clock);
    await expect(reader.init()).rejects.toBeInstanceOf(RoomNotAccessibleError);
    expect(hs.count('POST', '/join')).toBe(2);
    expect(hs.count('GET', '/messages')).toBe(1);
    await reader.dispose();
  });

  it('joins again and retries once when a load is refused for membership', async () => {
    const hs = seededHomeserver();
    const client = hs.client();
    const first = new MatrixProviderManager(client, config());
    await first.init();
    await first.dispose();

    hs.messagesScript = [{ status: 403, errcode: 'M_FORBIDDEN' }];
    const second = new MatrixProviderManager(
      client,
      config({ retryAttempts: 1 }),
    );
    const { doc } = await second.init();
    expect(doc.getMap('m').get('seed')).toBe('value');
    expect(hs.count('POST', '/join')).toBe(2);
    expect(hs.count('GET', '/messages')).toBe(3);
    await second.dispose();
  });

  it('does not retry a refused load more than once', async () => {
    const hs = seededHomeserver();
    const client = hs.client();
    const first = new MatrixProviderManager(client, config());
    await first.init();
    await first.dispose();

    hs.messagesFailure = { status: 403, errcode: 'M_FORBIDDEN' };
    const second = new MatrixProviderManager(client, config());
    await expect(second.init()).rejects.toThrow();
    expect(hs.count('GET', '/messages')).toBe(3);
    await second.dispose();
  });
});

describe('MatrixProviderManager: disposal stops a load', () => {
  it('disposing during the retry back-off ends the load at once and sends nothing more', async () => {
    const hs = seededHomeserver();
    hs.messagesFailure = { status: 502, errcode: 'M_UNKNOWN' };
    const cfg = config({ retryAttempts: 3 });
    cfg.provider.retryDelayMs = 2_000;
    const manager = new MatrixProviderManager(hs.client(), cfg);

    const loading = manager.init();
    const settled = loading.then(
      () => Date.now(),
      () => Date.now(),
    );
    while (hs.count('GET', '/messages') === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const disposedAt = Date.now();
    await manager.dispose();

    await expect(loading).rejects.toThrow();
    expect((await settled) - disposedAt).toBeLessThan(500);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(hs.count('GET', '/messages')).toBe(1);
    expect(hs.count('POST', '/join')).toBe(1);
  });
});

describe('MatrixProviderManager: writes', () => {
  it('flushes a write to the room and reports no failure', async () => {
    const hs = seededHomeserver();
    const { manager, doc } = await openManager(hs);
    doc.getMap('m').set('written', 'yes');

    expect(await manager.flush()).toBeUndefined();
    expect(hs.docOf(ROOM).getMap('m').get('written')).toBe('yes');
    await manager.dispose();
  });

  it('reports a write the homeserver forbade as forbidden, after one send', async () => {
    const hs = seededHomeserver();
    const { manager, doc } = await openManager(hs);
    hs.sendScript = [{ status: 403, errcode: 'M_FORBIDDEN' }];
    doc.getMap('m').set('written', 'yes');

    expect(await manager.flush()).toMatchObject({ kind: 'forbidden' });
    expect(manager.matrixProvider?.canWrite).toBe(false);
    expect(hs.count('PUT', '/send/matrix-crdt.doc_update')).toBe(1);
    await manager.dispose();
  });

  it('abandons a write the homeserver keeps failing after a bounded number of sends', async () => {
    const hs = seededHomeserver();
    const { manager, doc } = await openManager(hs);
    hs.sendScript = Array.from({ length: 50 }, () => ({
      status: 500,
      errcode: 'M_UNKNOWN',
    }));
    doc.getMap('m').set('written', 'yes');

    const started = Date.now();
    expect(await manager.flush()).toMatchObject({ kind: 'unsent' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(hs.count('PUT', '/send/matrix-crdt.doc_update')).toBe(3);
    // Callers that only look at canWrite still fail closed.
    expect(manager.matrixProvider?.canWrite).toBe(false);

    await manager.dispose();
    const sendsAtDispose = hs.count('PUT', '/send/matrix-crdt.doc_update');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(hs.count('PUT', '/send/matrix-crdt.doc_update')).toBe(
      sendsAtDispose,
    );
  });

  it('abandons an oversized write at once (413 cannot succeed on retry)', async () => {
    const hs = seededHomeserver();
    const { manager, doc } = await openManager(hs);
    hs.sendScript = [{ status: 413, errcode: 'M_TOO_LARGE' }];
    doc.getMap('m').set('written', 'yes');

    expect(await manager.flush()).toMatchObject({ kind: 'unsent' });
    expect(hs.count('PUT', '/send/matrix-crdt.doc_update')).toBe(1);
    await manager.dispose();
  });

  it("waits the homeserver's retry_after_ms before re-sending a rate-limited write", async () => {
    const hs = seededHomeserver();
    const { manager, doc } = await openManager(hs);
    hs.sendScript = [
      { status: 429, errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 300 },
    ];
    doc.getMap('m').set('written', 'yes');

    expect(await manager.flush()).toBeUndefined();
    const sends = hs.requests.filter((r) =>
      r.path.includes('/send/matrix-crdt.doc_update'),
    );
    expect(sends).toHaveLength(2);
    expect(sends[1]!.at - sends[0]!.at).toBeGreaterThanOrEqual(300);
    expect(hs.docOf(ROOM).getMap('m').get('written')).toBe('yes');
    await manager.dispose();
  });
});
