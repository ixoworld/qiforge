/**
 * Devnet feature matrix — exercises every user-facing feature of a DEPLOYED
 * Workers oracle with a real devnet account, and reports pass/fail per
 * feature. Continues past failures so one run yields the whole picture.
 *
 *   ACCOUNT_JSON=<path> ORACLE_URL=https://… tsx test/devnet-features.ts
 *
 * The account JSON is what `testing-harness/scripts/devnet-mig-account.mjs`
 * prints: `{ did, address, edSigningMnemonic, matrixUserId, matrixPassword,
 * roomId }` — a chain identity with an Ed25519 verification method, a Matrix
 * account on the oracle's user homeserver, and the user↔oracle room.
 *
 * Covered: health, auth, models, delegation deposit/read/delete, VFS grant,
 * sessions CRUD + titles, streaming + non-streaming turns, transcript, thread
 * memory, abort, memory-engine tools, sandbox, skills, flows, VFS tools,
 * firecrawl + domain-indexer sub-agents, per-room secrets via BYO credential
 * round-trip, owner-store flush/reset/reload through VFS, E2EE Matrix ingress,
 * a live scheduled task delivered to the room, and per-user rate limiting.
 */
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import type { ImageContent } from 'matrix-js-sdk/lib/@types/media';
import * as Y from 'yjs';
import { ChatClient, type SSEEvent } from './lib/chat-client';
import {
  depositVfsDelegation,
  mintAuthInvocation,
  mintDelegation,
  vfsUserRequest,
  waitFor,
  type HarnessAccount,
} from './lib/harness';
import { SocketIoClient } from './lib/socket-client';

const ORACLE_URL =
  process.env.ORACLE_URL ?? 'https://mike-devnet-oracle.ixo-api.workers.dev';
const ORACLE_DID =
  process.env.ORACLE_DID ??
  'did:ixo:ixo1seyngesnj6673qqzf0um4e6c2rutfsrafc9tw3';
const MATRIX_BASE = process.env.MATRIX_BASE ?? 'https://mx.mike-test.ixo.world';
const BOT_USER_ID =
  process.env.BOT_USER_ID ??
  '@did-ixo-ixo1seyngesnj6673qqzf0um4e6c2rutfsrafc9tw3:mx.mike-test.ixo.world';
const UCAN_STORE =
  process.env.UCAN_STORE_URL ?? 'https://devnet.store.ucan.ixo.earth';
const VFS_URL = process.env.VFS_BASE_URL ?? 'https://devnet.vfs.ixo.earth';
/**
 * Devnet test accounts (gitignored `test/.devnet-accounts/`): the main user in
 * `devnet-account.json`, the others as `devnet-user-<n>.json` — created with
 * the testing harness's `devnet-mig-account.mjs`.
 */
const SCRATCH =
  process.env.SCRATCH_DIR ??
  fileURLToPath(new URL('./.devnet-accounts', import.meta.url));
const ACCOUNT_JSON =
  process.env.ACCOUNT_JSON ?? `${SCRATCH}/devnet-account.json`;

interface DevnetAccount {
  did: string;
  address: string;
  edSigningMnemonic: string;
  matrixUserId: string;
  matrixPassword: string;
  roomId: string;
  matrixAccessToken?: string;
}

const results: Array<{
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}> = [];
/** `STEP_FILTER=<regex>` runs only the matching steps (for isolating one). */
const STEP_FILTER = process.env.STEP_FILTER
  ? new RegExp(process.env.STEP_FILTER)
  : null;

async function step<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  if (STEP_FILTER && !STEP_FILTER.test(name)) {
    console.log(`▷ ${name} … skipped (STEP_FILTER)`);
    return undefined;
  }
  const t0 = Date.now();
  process.stdout.write(`▶ ${name} … `);
  try {
    const out = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`ok (${Date.now() - t0} ms)`);
    return out;
  } catch (err) {
    const cause =
      err instanceof Error && err.cause instanceof Error
        ? ` (cause: ${err.cause.message}${'code' in err.cause ? ` ${String(err.cause.code)}` : ''})`
        : '';
    const detail = (err instanceof Error ? err.message : String(err)) + cause;
    results.push({ name, ok: false, ms: Date.now() - t0, detail });
    console.log(`FAILED (${Date.now() - t0} ms)\n    ${detail.slice(0, 400)}`);
    return undefined;
  }
}

const toolCalls = (events: SSEEvent[]): string[] =>
  events
    .filter((e) => e.event === 'tool_call')
    .map((e) => {
      const d = e.data as { toolName?: string; name?: string; status?: string };
      return `${d.toolName ?? d.name ?? '?'}:${d.status ?? ''}`;
    });
/** `name(args)` of every finished tool call whose output looks like an error. */
const failingToolArgs = (events: SSEEvent[]): string[] =>
  events
    .filter((e) => e.event === 'tool_call')
    .map(
      (e) =>
        e.data as {
          toolName?: string;
          status?: string;
          output?: unknown;
          args?: unknown;
        },
    )
    .filter(
      (d) =>
        d.status === 'done' &&
        typeof d.output === 'string' &&
        /returned an error|Error code|error calling tool|did not complete|^⚠️/i.test(
          d.output,
        ),
    )
    .map((d) => `${d.toolName ?? '?'}(${JSON.stringify(d.args ?? {})})`);
/** Error outputs of finished tool calls (e.g. an MCP server that answered with an error). */
const toolErrors = (events: SSEEvent[]): string[] =>
  events
    .filter((e) => e.event === 'tool_call')
    .map((e) => e.data as { status?: string; output?: unknown })
    .filter((d) => d.status === 'done' && typeof d.output === 'string')
    .map((d) => String(d.output))
    .filter((o) =>
      /returned an error|Error code|error calling tool|did not complete/i.test(
        o,
      ),
    );
const doneTools = (events: SSEEvent[]): string[] =>
  toolCalls(events)
    .filter((t) => t.endsWith(':done'))
    .map((t) => t.replace(/:done$/, ''));
const toolOutput = (events: SSEEvent[], toolPrefix: string): string =>
  events
    .filter((e) => e.event === 'tool_call')
    .map(
      (e) => e.data as { toolName?: string; status?: string; output?: unknown },
    )
    .filter(
      (d) => d.status === 'done' && (d.toolName ?? '').startsWith(toolPrefix),
    )
    .map((d) =>
      typeof d.output === 'string' ? d.output : JSON.stringify(d.output ?? ''),
    )
    .join('\n');

async function authed(
  user: HarnessAccount,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`${ORACLE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await mintAuthInvocation(user, ORACLE_DID)}`,
      'X-Auth-Type': 'ucan',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON body
  }
  return { status: res.status, json, text };
}

// ── media helpers for the attachment steps ─────────────────────────────────
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k += 1)
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A solid-colour RGB PNG built from scratch (no image library needed). */
function makePng(
  width: number,
  height: number,
  [r, g, b]: [number, number, number],
): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const typeBytes = new TextEncoder().encode(type);
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(typeBytes, 4);
    out.set(data, 8);
    const crcInput = new Uint8Array(typeBytes.length + data.length);
    crcInput.set(typeBytes);
    crcInput.set(data, typeBytes.length);
    view.setUint32(8 + data.length, crc32(crcInput));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) raw.set([r, g, b], row + 1 + x * 3);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** Matrix E2E attachment encryption (AES-256-CTR, spec v2) as Element does it. */
function encryptAttachment(bytes: Uint8Array): {
  ciphertext: Uint8Array;
  file: Omit<ImageContent['file'] & object, 'url'>;
} {
  const key = randomBytes(32);
  const iv = Buffer.concat([randomBytes(8), Buffer.alloc(8)]);
  const cipher = createCipheriv('aes-256-ctr', key, iv);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const unpadded = (b64: string) => b64.replace(/=+$/, '');
  return {
    ciphertext: new Uint8Array(ciphertext),
    file: {
      key: {
        alg: 'A256CTR',
        ext: true,
        k: key.toString('base64url'),
        key_ops: ['encrypt', 'decrypt'],
        kty: 'oct',
      },
      iv: unpadded(iv.toString('base64')),
      hashes: {
        sha256: unpadded(
          createHash('sha256').update(ciphertext).digest('base64'),
        ),
      },
      v: 'v2',
    },
  };
}

async function main(): Promise<void> {
  const acct = JSON.parse(readFileSync(ACCOUNT_JSON, 'utf8')) as DevnetAccount;
  const user: HarnessAccount = {
    name: 'devnet-features',
    address: acct.address,
    did: acct.did,
    edSigningMnemonic: acct.edSigningMnemonic,
    matrixUserId: acct.matrixUserId,
    matrixPassword: acct.matrixPassword,
    matrixMnemonic: '',
  };
  const client = () =>
    mintAuthInvocation(user, ORACLE_DID).then(
      (invocation) => new ChatClient(ORACLE_URL, { invocation }),
    );
  console.log(`devnet feature matrix — ${ORACLE_URL} as ${acct.did}\n`);

  // ── platform ─────────────────────────────────────────────────────────────
  await step('health: /health, /health/matrix, /matrix/status', async () => {
    // Right after a deploy the gateway object cold-boots (crypto restore +
    // initial sync) and /health/matrix answers 503 until it is up.
    const deadline = Date.now() + 180_000;
    let last = '';
    for (;;) {
      const res = await fetch(`${ORACLE_URL}/health/matrix`);
      if (res.status === 200) break;
      last = `${res.status} ${(await res.text()).slice(0, 120)}`;
      assert.ok(
        Date.now() < deadline,
        `/health/matrix not healthy after 3 min: ${last}`,
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
    for (const p of ['/health', '/health/matrix', '/matrix/status']) {
      const res = await fetch(`${ORACLE_URL}${p}`);
      assert.equal(res.status, 200, `${p} → ${res.status}`);
    }
    const st = (await (await fetch(`${ORACLE_URL}/matrix/status`)).json()) as {
      running?: boolean;
      cryptoReady?: boolean;
    };
    assert.equal(st.running, true, 'gateway not running');
    assert.equal(st.cryptoReady, true, 'gateway crypto not ready');
  });

  await step(
    'auth: unauthenticated and bad tokens are rejected (401)',
    async () => {
      const r1 = await fetch(`${ORACLE_URL}/sessions`);
      assert.equal(r1.status, 401);
      const r2 = await fetch(`${ORACLE_URL}/sessions`, {
        headers: { Authorization: 'Bearer not-a-ucan', 'X-Auth-Type': 'ucan' },
      });
      assert.equal(r2.status, 401);
    },
  );

  await step(
    'models: GET /models lists priced platform models in the Node shape',
    async () => {
      const r = await authed(user, 'GET', '/models');
      assert.equal(r.status, 200, r.text.slice(0, 200));
      // Node's `ModelListing` — `{ models, default }`; the client SDK's
      // `useModels` reads `default` and types `pricing` as required.
      const body = r.json as {
        models?: Array<{
          id?: string;
          isDefault?: boolean;
          pricing?: {
            inputPerMillion?: number;
            outputPerMillion?: number;
            currency?: string;
            unit?: string;
          };
        }>;
        default?: string;
      };
      const list = body.models;
      assert.ok(
        Array.isArray(list) && list.length > 0,
        `no models: ${r.text.slice(0, 200)}`,
      );
      assert.equal(
        typeof body.default,
        'string',
        `no \`default\` id: ${r.text.slice(0, 200)}`,
      );
      assert.ok(
        list.some((m) => m.id === body.default && m.isDefault === true),
        `default ${body.default} is not flagged in the list`,
      );
      for (const m of list) {
        assert.ok(
          m.pricing &&
            m.pricing.inputPerMillion! > 0 &&
            m.pricing.outputPerMillion! > 0 &&
            m.pricing.currency === 'USD' &&
            m.pricing.unit === 'per_million_tokens',
          `model ${m.id} has no usable pricing: ${JSON.stringify(m.pricing)}`,
        );
      }
    },
  );

  await step(
    'delegation: deposit → GET authorized → delete → unauthorized',
    async () => {
      const raw = await mintDelegation(user, ORACLE_DID, [
        { can: '*', with: 'ixo:oracle' },
        { can: '*', with: 'ixo:memory' },
        { can: '*', with: 'ixo:sandbox' },
        { can: '*', with: 'ixo:skills' },
      ]);
      const post = await authed(user, 'POST', '/delegation', {
        raw,
        expiration: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      });
      assert.equal(post.status, 200, post.text.slice(0, 200));
      const get = await authed(user, 'GET', '/delegation');
      assert.equal(
        (get.json as { authorized?: boolean }).authorized,
        true,
        get.text,
      );
      const del = await authed(user, 'DELETE', '/delegation');
      assert.ok(del.status < 300, del.text.slice(0, 200));
      const get2 = await authed(user, 'GET', '/delegation');
      assert.equal(
        (get2.json as { authorized?: boolean }).authorized,
        false,
        get2.text,
      );
      // Leave a valid deposit in place for the plugin steps below.
      const post2 = await authed(user, 'POST', '/delegation', {
        raw,
        expiration: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      });
      assert.equal(post2.status, 200, post2.text.slice(0, 200));
    },
  );

  await step(
    'VFS: deposit an ixo:filesystem grant in the devnet UCAN store',
    async () => {
      const { cid } = await depositVfsDelegation(user, ORACLE_DID, UCAN_STORE);
      assert.ok(cid, 'no cid');
    },
  );

  // ── sessions + turns ─────────────────────────────────────────────────────
  let sessionId = '';
  await step('sessions: POST creates, GET lists', async () => {
    const c = await client();
    sessionId = await c.createSession();
    assert.ok(sessionId, 'no session id');
    const body = (await c.listSessions()) as {
      sessions: Array<{ sessionId: string }>;
    };
    assert.ok(
      body.sessions.some((s) => s.sessionId === sessionId),
      'new session not listed',
    );
  });

  await step('chat: streaming turn yields message + done events', async () => {
    const c = await client();
    const r = await c.stream(
      sessionId,
      'Remember this number: 4242. Reply with exactly: NOTED',
    );
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.ok(
      r.events.some((e) => e.event === 'message'),
      'no message events',
    );
    assert.ok(
      r.events.some((e) => e.event === 'done'),
      'no done event',
    );
    assert.match(
      r.text,
      /NOTED/i,
      `unexpected reply: "${r.text.slice(0, 120)}"`,
    );
  });

  await step('chat: non-streaming turn returns JSON', async () => {
    const c = await client();
    const r = await c.send(sessionId, 'Reply with exactly: PONG');
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.match(
      JSON.stringify(r.body),
      /PONG/i,
      JSON.stringify(r.body).slice(0, 200),
    );
  });

  await step('transcript: GET /messages/:id has the turns', async () => {
    const c = await client();
    const { messages } = await c.listMessages(sessionId);
    assert.ok(messages.length >= 4, `only ${messages.length} messages`);
  });

  await step('thread memory: same session recalls the number', async () => {
    const c = await client();
    const r = await c.stream(
      sessionId,
      'What number did I ask you to remember? Only the number.',
    );
    assert.match(r.text, /4242/, `recall failed: "${r.text.slice(0, 120)}"`);
  });

  await step(
    'sessions: a title is generated after the first turn',
    async () => {
      const c = await client();
      const deadline = Date.now() + 60_000;
      let title = '';
      while (Date.now() < deadline) {
        const body = (await c.listSessions()) as {
          sessions: Array<{ sessionId: string; title?: string }>;
        };
        title =
          body.sessions.find((s) => s.sessionId === sessionId)?.title ?? '';
        if (title && title !== 'Untitled') break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      assert.ok(
        title && title !== 'Untitled',
        `title still "${title || '(empty)'}"`,
      );
    },
  );

  await step('abort: mid-stream abort ends the stream quickly', async () => {
    const c = await client();
    const s = await c.createSession();
    const ac = new AbortController();
    let aborted = false;
    const streamP = c
      .stream(s, 'Write a 2000-word essay about the history of mathematics.', {
        signal: ac.signal,
        onEvent: (e) => {
          if (!aborted && e.event === 'message') {
            aborted = true;
            void c.abort(s);
          }
        },
      })
      .catch((e: unknown) => ({
        text: String(e),
        events: [] as SSEEvent[],
        status: 0,
        durationMs: 0,
        requestId: null,
      }));
    const r = await Promise.race([
      streamP,
      new Promise<null>((res) => setTimeout(() => res(null), 60_000)),
    ]);
    assert.ok(r !== null, 'stream did not end within 60 s after abort');
    assert.ok(aborted, 'never saw a message event to abort on');
  });

  await step('sessions: DELETE removes a session', async () => {
    const c = await client();
    const s = await c.createSession();
    const r = await authed(
      user,
      'DELETE',
      `/sessions/${encodeURIComponent(s)}`,
    );
    assert.ok(r.status < 300, r.text.slice(0, 200));
    const body = (await c.listSessions()) as {
      sessions: Array<{ sessionId: string }>;
    };
    assert.ok(
      !body.sessions.some((x) => x.sessionId === s),
      'deleted session still listed',
    );
  });

  // ── plugins / tools ──────────────────────────────────────────────────────
  const tag = Math.random().toString(36).slice(2, 8);
  // Memory recall targets are real words: the memory engine's hybrid search
  // (embeddings + entity extraction) does not match a random token well.
  const pick = (xs: readonly string[]): string =>
    xs[Math.floor(Math.random() * xs.length)]!;
  const ADJECTIVES = [
    'Velvet',
    'Amber',
    'Cobalt',
    'Saffron',
    'Indigo',
    'Marble',
    'Copper',
    'Ivory',
    'Scarlet',
    'Onyx',
    'Jade',
    'Slate',
    'Coral',
    'Ember',
    'Quartz',
    'Willow',
  ] as const;
  const ANIMALS = [
    'Otter',
    'Falcon',
    'Heron',
    'Lynx',
    'Badger',
    'Kestrel',
    'Marten',
    'Osprey',
    'Puffin',
    'Raven',
    'Stoat',
    'Tern',
    'Vole',
    'Wren',
    'Ibis',
    'Gannet',
  ] as const;
  const codename = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;

  await step('memory-engine: add_memory runs (tool call done)', async () => {
    const c = await client();
    const s = await c.createSession();
    const r = await c.stream(
      s,
      `Store this in long-term memory with the memory tool: the project codename for ticket ${tag.toUpperCase()} is "${codename}". Confirm once stored.`,
    );
    const done = doneTools(r.events);
    assert.ok(
      done.some((t) => /add_memory/.test(t)),
      `no add_memory call; tools: ${toolCalls(r.events).join(', ') || '(none)'}`,
    );
  });

  await step('sandbox: sandbox_run executes Python (42)', async () => {
    const c = await client();
    const s = await c.createSession();
    const r = await c.stream(
      s,
      'Call the sandbox_run tool with this Python code and report its stdout verbatim: print(6*7)',
    );
    const done = doneTools(r.events);
    assert.ok(
      done.some((t) => /sandbox_run/.test(t)),
      `no sandbox_run call; tools: ${toolCalls(r.events).join(', ') || '(none)'}`,
    );
    assert.match(
      toolOutput(r.events, 'sandbox_run') + r.text,
      /42/,
      `no 42 in output/reply: "${r.text.slice(0, 160)}"`,
    );
  });

  await step('skills: list_skills / search_skills run', async () => {
    const c = await client();
    const s = await c.createSession();
    const r = await c.stream(
      s,
      'Call the list_skills tool and tell me how many skills came back.',
    );
    const done = doneTools(r.events);
    assert.ok(
      done.some((t) => /list_skills|search_skills/.test(t)),
      `no skills tool call; tools: ${toolCalls(r.events).join(', ') || '(none)'}`,
    );
  });

  await step('flows: list_actions runs', async () => {
    const c = await client();
    const s = await c.createSession();
    const r = await c.stream(
      s,
      // Name the capability: with the Portal and AG-UI plugins in the
      // catalog, "actions" alone can route the model to `portal` (which
      // contributes no tools without client-declared browser tools).
      'Load the "flows" capability (Flow Builder) and call its list_actions tool, then name three actions it returned.',
    );
    const done = doneTools(r.events);
    assert.ok(
      done.some((t) => /list_actions/.test(t)),
      `no list_actions call; tools: ${toolCalls(r.events).join(', ') || '(none)'}`,
    );
  });

  await step(
    'vfs: vfs_write + vfs_read round-trip, verified through the VFS API',
    async () => {
      const c = await client();
      const s = await c.createSession();
      const r = await c.stream(
        s,
        `Use the vfs_write tool to write a file at /devnet-features/${tag}.txt with content "hello ${tag}", then use vfs_read on the same path and quote its content.`,
      );
      const done = doneTools(r.events);
      assert.ok(
        done.some((t) => /vfs_write/.test(t)),
        `no vfs_write call; tools: ${toolCalls(r.events).join(', ') || '(none)'}`,
      );
      const list = await vfsUserRequest(
        user,
        'fs/list',
        'GET',
        `/files?path=${encodeURIComponent('/devnet-features')}&limit=100`,
        { vfsUrl: VFS_URL },
      );
      const listText = await list.text();
      assert.equal(
        list.status,
        200,
        `VFS list → ${list.status} ${listText.slice(0, 160)}`,
      );
      const files =
        (
          JSON.parse(listText) as {
            files?: Array<{ id: string; name?: string; path?: string }>;
          }
        ).files ?? [];
      const file = files.find((f) =>
        (f.name ?? f.path ?? '').includes(`${tag}.txt`),
      );
      assert.ok(
        file,
        `file ${tag}.txt not in VFS listing (${files.length} files; vfs_write output: ${toolOutput(r.events, 'vfs_write').slice(0, 200)})`,
      );
      const read = await vfsUserRequest(
        user,
        'fs/read',
        'GET',
        `/files/${encodeURIComponent(file.id)}/content`,
        { vfsUrl: VFS_URL },
      );
      assert.equal(read.status, 200, `VFS read → ${read.status}`);
      assert.match(
        await read.text(),
        new RegExp(`hello ${tag}`),
        'file content mismatch',
      );
    },
  );

  await step('firecrawl sub-agent: web scrape of example.com', async () => {
    const c = await client();
    const s = await c.createSession();
    const r = await c.stream(
      s,
      'Use your web research (firecrawl) capability to fetch https://example.com and tell me the page heading text.',
    );
    const calls = toolCalls(r.events);
    assert.ok(
      calls.some((t) => /firecrawl|scrape|web/i.test(t)),
      `no firecrawl call; tools: ${calls.join(', ') || '(none)'}`,
    );
    assert.match(
      r.text,
      /example domain/i,
      `heading not found in reply: "${r.text.slice(0, 160)}"`,
    );
  });

  await step('domain-indexer sub-agent: domain lookup', async () => {
    const c = await client();
    const s = await c.createSession();
    const r = await c.stream(
      s,
      'Use the domain indexer capability to search for domains matching "ixo" and list what it returns.',
    );
    const calls = toolCalls(r.events);
    assert.ok(
      calls.some((t) => /domain/i.test(t)),
      `no domain-indexer call; tools: ${calls.join(', ') || '(none)'}`,
    );
  });

  await step(
    'secrets: BYO credential save → status → delete (per-room secrets)',
    async () => {
      const put = await authed(user, 'PUT', '/byo-llm/credentials/openai', {
        apiKey: `sk-test-${tag}-not-a-real-key`,
      });
      assert.ok(
        put.status < 300,
        `PUT → ${put.status} ${put.text.slice(0, 200)}`,
      );
      const st = await authed(user, 'GET', '/byo-llm/status');
      assert.equal(st.status, 200, st.text.slice(0, 200));
      assert.match(
        st.text,
        /openai/,
        `openai missing from status: ${st.text.slice(0, 200)}`,
      );
      const del = await authed(user, 'DELETE', '/byo-llm/credentials/openai');
      assert.ok(
        del.status < 300,
        `DELETE → ${del.status} ${del.text.slice(0, 200)}`,
      );
    },
  );

  await step(
    'owner store: flush lands the file in VFS; reset + reload keeps sessions',
    async () => {
      // Two forced flushes with a write in between: the second must REPLACE
      // the file (delete + move of a temp upload), never add a version or
      // leave a `.uploading-` temp behind, and the state file stays unique.
      const listOracleFiles = async (): Promise<
        Array<{ path: string; id: string; size?: number }>
      > => {
        const list = await vfsUserRequest(
          user,
          'fs/list',
          'GET',
          `/files?path=${encodeURIComponent('/.oracles')}&limit=200`,
          { vfsUrl: VFS_URL },
        );
        const listText = await list.text();
        assert.equal(
          list.status,
          200,
          `VFS list → ${list.status} ${listText.slice(0, 160)}`,
        );
        const files = (JSON.parse(listText) as { files?: unknown[] }).files;
        assert.ok(
          Array.isArray(files),
          `VFS list has no files[]: ${listText.slice(0, 160)}`,
        );
        return files.filter(
          (f): f is { path: string; id: string; size?: number } =>
            typeof f === 'object' &&
            f !== null &&
            typeof Reflect.get(f, 'path') === 'string' &&
            typeof Reflect.get(f, 'id') === 'string',
        );
      };
      const assertSingleStateFile = async (label: string) => {
        const files = await listOracleFiles();
        const state = files.filter((f) => f.path.endsWith('/state.db.gz'));
        const temps = files.filter((f) => f.path.includes('.uploading-'));
        assert.ok(
          state.length >= 1,
          `${label}: no state.db.gz under /.oracles: ${JSON.stringify(files).slice(0, 200)}`,
        );
        const byPath = new Map<string, number>();
        for (const f of state)
          byPath.set(f.path, (byPath.get(f.path) ?? 0) + 1);
        for (const [path, n] of byPath)
          assert.equal(
            n,
            1,
            `${label}: ${n} files at ${path} (expected exactly one)`,
          );
        assert.equal(
          temps.length,
          0,
          `${label}: temp upload left behind: ${temps.map((t) => t.path).join(', ')}`,
        );
        return state;
      };

      const first = await authed(user, 'POST', '/debug/storage/flush');
      assert.ok(
        first.status < 300,
        `flush → ${first.status} ${first.text.slice(0, 200)}`,
      );
      const stateBefore = await assertSingleStateFile('after first flush');

      // A write between the flushes so the second one has something to send.
      await (await client()).createSession();
      const second = await authed(user, 'POST', '/debug/storage/flush');
      assert.ok(
        second.status < 300,
        `second flush → ${second.status} ${second.text.slice(0, 200)}`,
      );
      const secondBody = JSON.parse(second.text) as {
        uploaded?: boolean;
        skipped?: string;
        fallback?: string;
      };
      assert.equal(
        secondBody.uploaded,
        true,
        `second flush did not upload: ${second.text.slice(0, 200)}`,
      );
      assert.equal(
        secondBody.fallback,
        undefined,
        `second flush fell back to Matrix media: ${second.text.slice(0, 200)}`,
      );
      const stateAfter = await assertSingleStateFile('after second flush');
      const idsBefore = new Set(stateBefore.map((f) => f.id));
      assert.ok(
        stateAfter.some((f) => !idsBefore.has(f.id)),
        'second flush did not replace the state file (same file id — a PUT version instead of delete + move?)',
      );

      const status = await authed(user, 'GET', '/debug/storage');
      assert.ok(status.status < 300, `/debug/storage → ${status.status}`);
      const storage = JSON.parse(status.text) as {
        dirty?: boolean;
        writeGeneration?: number;
        uploadedGeneration?: number;
        flushFailures?: number;
        legacyCleared?: boolean;
      };
      assert.equal(
        storage.flushFailures ?? 0,
        0,
        `flush failures recorded: ${status.text.slice(0, 200)}`,
      );
      // Nothing is ever written to Matrix any more, and once VFS is confirmed
      // the old Matrix copy (this user migrated from the Node runtime) is
      // redacted; the object remembers that it checked.
      assert.equal(
        storage.legacyCleared,
        true,
        `legacy Matrix copy not cleared: ${status.text.slice(0, 200)}`,
      );
      assert.equal(
        storage.uploadedGeneration,
        storage.writeGeneration,
        `uploaded generation lags the file: ${status.text.slice(0, 200)}`,
      );

      const before = (
        (await (await client()).listSessions()) as { sessions: unknown[] }
      ).sessions.length;
      const reset = await authed(user, 'POST', '/debug/storage/reset');
      assert.ok(
        reset.status < 300,
        `reset → ${reset.status} ${reset.text.slice(0, 200)}`,
      );
      const after = (
        (await (await client()).listSessions()) as { sessions: unknown[] }
      ).sessions.length;
      assert.ok(
        after >= before - 1 && after > 0,
        `sessions after reload: ${after} (before ${before})`,
      );
    },
  );

  // ── Matrix ingress (E2EE) + scheduled task ───────────────────────────────
  const login = await fetch(`${MATRIX_BASE}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: acct.matrixUserId },
      password: acct.matrixPassword,
      initial_device_display_name: 'devnet-features',
    }),
  });
  const mxSession = (await login.json()) as {
    access_token: string;
    user_id: string;
    device_id: string;
  };
  const sdk = await import('matrix-js-sdk');
  const mx = sdk.createClient({
    baseUrl: MATRIX_BASE,
    accessToken: mxSession.access_token,
    userId: mxSession.user_id,
    deviceId: mxSession.device_id,
    store: new sdk.MemoryStore(),
    useAuthorizationHeader: true,
  });
  await mx.initRustCrypto({ useIndexedDB: false });
  await mx.startClient({ initialSyncLimit: 5, lazyLoadMembers: true });
  await new Promise<void>((resolve) => {
    const onSync = (state: string) => {
      if (state === 'PREPARED' || state === 'SYNCING') {
        mx.removeListener(sdk.ClientEvent.Sync, onSync);
        resolve();
      }
    };
    mx.on(sdk.ClientEvent.Sync, onSync);
  });
  const roomId = acct.roomId;
  /** Resolve with the first bot event after `after` that satisfies `pick`. */
  const waitForBotEvent = (
    after: number,
    pick: (event: import('matrix-js-sdk').MatrixEvent) => boolean,
    what: string,
    timeoutMs = 120_000,
  ) =>
    new Promise<import('matrix-js-sdk').MatrixEvent>((resolve, reject) => {
      const seen: string[] = [];
      const listener = (event: import('matrix-js-sdk').MatrixEvent): void => {
        void (async () => {
          if (event.getRoomId() !== roomId || event.getSender() !== BOT_USER_ID)
            return;
          if (event.getTs() < after) return;
          await mx.decryptEventIfNeeded(event);
          const c: {
            component?: string;
            props?: { phase?: string };
            'm.new_content'?: { props?: { phase?: string } };
          } = event.getContent();
          seen.push(
            `${event.getType()}${event.isDecryptionFailure() ? '(undecryptable)' : ''}${
              c.component
                ? `:${c.component}/${c['m.new_content']?.props?.phase ?? c.props?.phase ?? '?'}`
                : ''
            }`,
          );
          if (pick(event)) {
            clearTimeout(timer);
            mx.removeListener(sdk.RoomEvent.Timeline, listener);
            resolve(event);
          }
        })();
      };
      const timer = setTimeout(() => {
        mx.removeListener(sdk.RoomEvent.Timeline, listener);
        reject(
          new Error(
            `no bot event (${what}) within ${timeoutMs}ms; bot events seen: ${seen.join(', ') || '(none)'}`,
          ),
        );
      }, timeoutMs);
      mx.on(sdk.RoomEvent.Timeline, listener);
    });

  const waitForBotReply = (
    after: number,
    pattern: RegExp,
    timeoutMs = 150_000,
  ) =>
    new Promise<string>((resolve, reject) => {
      const listener = (event: import('matrix-js-sdk').MatrixEvent): void => {
        void (async () => {
          if (event.getRoomId() !== roomId || event.getSender() !== BOT_USER_ID)
            return;
          if (event.getTs() < after) return;
          await mx.decryptEventIfNeeded(event);
          if (event.getType() !== 'm.room.message') return;
          const body = String(event.getContent().body ?? '');
          if (pattern.test(body)) {
            clearTimeout(timer);
            mx.removeListener(sdk.RoomEvent.Timeline, listener);
            resolve(body);
          }
        })();
      };
      const timer = setTimeout(() => {
        mx.removeListener(sdk.RoomEvent.Timeline, listener);
        reject(
          new Error(`no bot reply matching ${pattern} within ${timeoutMs}ms`),
        );
      }, timeoutMs);
      mx.on(sdk.RoomEvent.Timeline, listener);
    });

  try {
    await step(
      'matrix ingress: encrypted room message → encrypted bot reply',
      async () => {
        const since = Date.now();
        const room = mx.getRoom(roomId);
        assert.ok(room, `user does not see room ${roomId}`);
        assert.ok(
          await mx.getCrypto()?.isEncryptionEnabledInRoom(roomId),
          'room is not encrypted',
        );
        // The Matrix turn drives a `work_status` card (an `ixo.oracle.component`
        // event edited in place). Arm the wait BEFORE sending: the final
        // `done` edit can land in the same sync batch as the reply text.
        const cardPromise = waitForBotEvent(
          since,
          (ev) => {
            if (ev.getType() !== 'ixo.oracle.component') return false;
            const c: {
              component?: string;
              props?: { phase?: string };
              'm.new_content'?: { props?: { phase?: string } };
            } = ev.getContent();
            if (c.component !== 'work_status') return false;
            const phase = c['m.new_content']?.props?.phase ?? c.props?.phase;
            return phase === 'done';
          },
          'work_status card reaching done',
          180_000,
        );
        cardPromise.catch(() => undefined); // awaited below; avoid an unhandled rejection meanwhile
        await mx.sendTextMessage(
          roomId,
          'What is 8 times 9? Reply with only the number.',
        );
        const reply = await waitForBotReply(since, /72/);
        const card = await cardPromise;
        assert.ok(card.getId(), 'work_status card event has no id');
        assert.match(reply, /72/);
        const last = room
          .getLiveTimeline()
          .getEvents()
          .filter((e) => e.getSender() === BOT_USER_ID)
          .at(-1);
        assert.ok(last?.isEncrypted(), 'bot reply is not E2EE');
      },
    );

    await step(
      'tasks: preview_task → create_task through the room',
      async () => {
        // Four minutes out: preview + create can take a while when the
        // gateway is mid-restart (create_task resolves the delivery room).
        const at = new Date(Date.now() + 240_000).toISOString();
        let since = Date.now();
        await mx.sendTextMessage(
          roomId,
          `Preview a background task for me (preview_task): title "Ping check ${tag}", schedule kind "once" at exactly "${at}", intent: 'Reply with exactly the word TASKPONG-${tag} and nothing else.' Show me the preview.`,
        );
        await waitForBotReply(since, /./s);
        since = Date.now();
        await mx.sendTextMessage(
          roomId,
          'Yes, that looks right — call create_task now with exactly the previewed title/intent/schedule, then reply with the task id the tool returned (it starts with "task_").',
        );
        const confirmation = await waitForBotReply(since, /./s);
        assert.match(
          confirmation,
          /task_/,
          `no task id — was create_task called? Reply: "${confirmation.slice(0, 200)}"`,
        );
      },
    );

    await step(
      'tasks: the DO alarm fires and the result is delivered to the room',
      async () => {
        const reply = await waitForBotReply(
          Date.now(),
          new RegExp(`TASKPONG-${tag}`),
          420_000,
        );
        assert.match(reply, /TASKPONG/);
      },
    );

    // ── attachments ──────────────────────────────────────────────────────
    await step(
      'attachments (HTTP): an mxc image + a text file reach the model; metadata persists on the transcript',
      async () => {
        const red = makePng(48, 48, [220, 20, 20]);
        const img = await mx.uploadContent(new Blob([red]), {
          type: 'image/png',
          name: `red-${tag}.png`,
        });
        const secret = `pineapple-${tag}`;
        const txt = new TextEncoder().encode(`The secret word is ${secret}.`);
        const doc = await mx.uploadContent(new Blob([txt]), {
          type: 'text/plain',
          name: `secret-${tag}.txt`,
        });
        const c = await client();
        const s = await c.createSession();
        const r = await c.stream(
          s,
          'Two files are attached. Answer in one line: (1) the dominant colour of the image, in one word; (2) the secret word quoted exactly from the text file.',
          {
            body: {
              attachments: [
                {
                  mxcUri: img.content_uri,
                  filename: `red-${tag}.png`,
                  mimetype: 'image/png',
                  size: red.length,
                },
                {
                  mxcUri: doc.content_uri,
                  filename: `secret-${tag}.txt`,
                  mimetype: 'text/plain',
                  size: txt.length,
                },
              ],
            },
          },
        );
        assert.equal(r.status, 200, r.text.slice(0, 200));
        assert.match(
          r.text,
          /red/i,
          `image colour not recognised: "${r.text.slice(0, 200)}"`,
        );
        assert.ok(
          r.text.includes(secret),
          `secret word not quoted from the text file: "${r.text.slice(0, 200)}"`,
        );
        const transcript = await authed(
          user,
          'GET',
          `/messages/${encodeURIComponent(s)}`,
        );
        const messages =
          (
            transcript.json as {
              messages?: Array<{ type?: string; attachments?: unknown[] }>;
            }
          ).messages ?? [];
        const human = messages.find(
          (m) => m.type === 'human' && Array.isArray(m.attachments),
        );
        assert.ok(
          human && human.attachments?.length === 2,
          `attachment metadata missing on the transcript: ${transcript.text.slice(0, 300)}`,
        );
      },
    );

    await step(
      'attachments (retention): an image older than 2 user turns is offloaded; view_attachment fetches it again; transcript keeps the metadata',
      async () => {
        const green = makePng(48, 48, [20, 200, 40]);
        const img = await mx.uploadContent(new Blob([green]), {
          type: 'image/png',
          name: `green-${tag}.png`,
        });
        const c = await client();
        const s = await c.createSession();
        const first = await c.stream(
          s,
          'One image is attached. What is its dominant colour? Reply with one word.',
          {
            body: {
              attachments: [
                {
                  mxcUri: img.content_uri,
                  filename: `green-${tag}.png`,
                  mimetype: 'image/png',
                  size: green.length,
                },
              ],
            },
          },
        );
        assert.equal(first.status, 200, first.text.slice(0, 200));
        assert.match(
          first.text,
          /green/i,
          `image colour not recognised: "${first.text.slice(0, 200)}"`,
        );
        // Two plain user turns push the image turn out of the retention
        // window (ATTACHMENT_PAYLOAD_TURNS = 2): its payload is rewritten to a
        // placeholder when the second one completes.
        for (const prompt of [
          'Reply with exactly: OK',
          'Reply with exactly: OK again',
        ]) {
          const r = await c.stream(s, prompt);
          assert.equal(r.status, 200, r.text.slice(0, 200));
        }
        const again = await c.stream(
          s,
          'Look at the image I attached at the start of this conversation again — fetch it if it is no longer inline — and tell me its dominant colour. Reply with one word.',
        );
        assert.equal(again.status, 200, again.text.slice(0, 200));
        assert.ok(
          doneTools(again.events).includes('view_attachment'),
          `no view_attachment call; tools: ${toolCalls(again.events).join(', ') || '(none)'}; errors: ${toolErrors(again.events).join(' | ') || '(none)'}; reply: "${again.text.slice(0, 200)}"`,
        );
        assert.match(
          again.text,
          /green/i,
          `re-fetched image not described: "${again.text.slice(0, 200)}"`,
        );
        const transcript = await authed(
          user,
          'GET',
          `/messages/${encodeURIComponent(s)}`,
        );
        const messages =
          (
            transcript.json as {
              messages?: Array<{
                type?: string;
                content?: string;
                attachments?: unknown[];
              }>;
            }
          ).messages ?? [];
        const humans = messages.filter((m) => m.type === 'human');
        assert.equal(
          humans.length,
          4,
          `expected the 4 user turns only (re-attachment hidden): ${humans.map((m) => m.content?.slice(0, 40)).join(' | ')}`,
        );
        assert.ok(
          humans[0]?.attachments?.length === 1,
          `attachment metadata missing on the offloaded message: ${transcript.text.slice(0, 300)}`,
        );
        assert.ok(
          !transcript.text.includes('[attachment offloaded]'),
          'retention placeholder leaked into the transcript',
        );
        assert.ok(
          !transcript.text.includes('source_type'),
          'inline payload leaked into the transcript',
        );
      },
    );

    await step(
      'attachments (Matrix): an encrypted m.image is decrypted and described; the event also works as an HTTP eventId attachment',
      async () => {
        const blue = makePng(48, 48, [20, 40, 220]);
        const enc = encryptAttachment(blue);
        const up = await mx.uploadContent(new Blob([enc.ciphertext]), {
          type: 'application/octet-stream',
          name: `blue-${tag}.png`,
        });
        const since = Date.now();
        const content: ImageContent = {
          msgtype: sdk.MsgType.Image,
          body: `blue-${tag}.png`,
          filename: `blue-${tag}.png`,
          info: { mimetype: 'image/png', size: blue.length, w: 48, h: 48 },
          file: { url: up.content_uri, ...enc.file },
        };
        const sent = await mx.sendMessage(roomId, content);
        // A caption sent right after the file lands in the same debounce
        // window and becomes one turn with the attachment (Node bridge
        // behaviour), so the reply has to come from the image content itself
        // rather than from a spontaneous description of a bare file share.
        await mx.sendMessage(roomId, {
          msgtype: sdk.MsgType.Text,
          body: 'What colour is the image I just shared? Answer with the colour name only.',
        });
        const reply = await waitForBotReply(since, /blue/i, 180_000);
        assert.match(reply, /blue/i);

        const c = await client();
        const s = await c.createSession();
        const r = await c.stream(
          s,
          'What is the dominant colour of the attached image? Reply with one word.',
          {
            body: {
              attachments: [
                {
                  eventId: sent.event_id,
                  filename: `blue-${tag}.png`,
                  mimetype: 'image/png',
                  size: blue.length,
                },
              ],
            },
          },
        );
        assert.equal(r.status, 200, r.text.slice(0, 200));
        assert.match(
          r.text,
          /blue/i,
          `encrypted eventId attachment not read over HTTP: "${r.text.slice(0, 200)}"`,
        );
      },
    );
    await step(
      'gateway restart: a room message sent while the Matrix client is down is answered after restart (catch-up)',
      async () => {
        const stop = await authed(user, 'POST', '/debug/matrix/stop');
        assert.equal(stop.status, 200, stop.text.slice(0, 200));
        const since = Date.now();
        const marker = `CATCHUP-${tag.toUpperCase()}`;
        await mx.sendTextMessage(
          roomId,
          `While you were away: reply with exactly ${marker}`,
        );
        // Give the message time to land on the server while the bot is down.
        await new Promise((r) => setTimeout(r, 5_000));
        const start = await authed(user, 'POST', '/matrix/start');
        assert.equal(start.status, 200, start.text.slice(0, 200));
        const reply = await waitForBotReply(since, new RegExp(marker), 150_000);
        assert.ok(reply.includes(marker));
        // A second start must not answer it again (processed-events dedupe).
        const status = await authed(user, 'GET', '/matrix/status');
        assert.equal(status.status, 200, status.text.slice(0, 200));
      },
    );
  } finally {
    mx.stopClient();
  }

  // ── user preferences (room state, Node-compatible) ───────────────────────
  await step(
    'matrix replay: an HTTP turn is replayed into the oracle room as a thread under the session (Node parity)',
    async () => {
      const created = await authed(user, 'POST', '/sessions', {});
      assert.equal(created.status, 201, created.text.slice(0, 200));
      const sid = (created.json as { sessionId: string }).sessionId;
      const marker = `REPLAY-${tag.toUpperCase()}`;
      const turn = await authed(user, 'POST', `/messages/${sid}`, {
        message: `Reply with exactly ${marker} and nothing else.`,
        stream: false,
      });
      assert.equal(turn.status, 200, turn.text.slice(0, 200));
      // Node replays the user message ("**You:** …") and the reply (prefixed
      // with the oracle name) into the room as a thread under the session's
      // root event, fire-and-forget. The thread relation is cleartext even in
      // an E2EE room, so the structure is checked through the client API
      // (this step must not depend on the syncing client, which only runs in
      // the Matrix section); bodies are checked when that client is up.
      const threadEvents = async () => {
        const res = await fetch(
          `${MATRIX_BASE}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=40`,
          { headers: { authorization: `Bearer ${mxSession.access_token}` } },
        );
        assert.equal(res.status, 200, `room messages → ${res.status}`);
        const body = (await res.json()) as {
          chunk: Array<{
            sender: string;
            type: string;
            content: {
              'm.relates_to'?: { rel_type?: string; event_id?: string };
            };
          }>;
        };
        return body.chunk.filter(
          (e) =>
            e.sender === BOT_USER_ID &&
            e.content['m.relates_to']?.rel_type === 'm.thread' &&
            e.content['m.relates_to']?.event_id === sid,
        );
      };
      await waitFor(
        async () => (await threadEvents()).length >= 2,
        60_000,
        `two replayed events threaded under session ${sid}`,
        2_000,
      );
      const room = mx.getRoom(roomId);
      if (mx.clientRunning && room) {
        const bodies: string[] = [];
        for (const e of room.getLiveTimeline().getEvents()) {
          if (e.getSender() !== BOT_USER_ID || e.threadRootId !== sid) continue;
          await mx.decryptEventIfNeeded(e);
          bodies.push(String(e.getContent().body ?? ''));
        }
        assert.ok(
          bodies.some((b) => /\*\*You:\*\*/.test(b) && b.includes(marker)),
          `no "**You:**" replay with the marker; bodies: ${JSON.stringify(bodies).slice(0, 300)}`,
        );
        assert.ok(
          bodies.some((b) => !/\*\*You:\*\*/.test(b) && b.includes(marker)),
          `no oracle reply replay with the marker; bodies: ${JSON.stringify(bodies).slice(0, 300)}`,
        );
      }
    },
  );

  await step(
    'user preferences: set_user_preferences → GET /user-preferences → next turn honours it',
    async () => {
      const suffix = Date.now().toString(36).slice(-4);
      const agentName = `Orin${suffix}`;
      const userName = `Zed${suffix}`;
      const c = await client();
      const s = await c.createSession();
      const r = await c.stream(
        s,
        `From now on call me ${userName}, and your own name is ${agentName}. Save these as my preferences with the preferences tool, then confirm in one line.`,
      );
      const done = doneTools(r.events);
      assert.ok(
        done.some((t) => /set_user_preferences/.test(t)),
        `no set_user_preferences call; tools: ${toolCalls(r.events).join(', ') || '(none)'}; reply: "${r.text.slice(0, 160)}"`,
      );
      const get = await authed(user, 'GET', '/user-preferences');
      assert.equal(
        get.status,
        200,
        `GET /user-preferences → ${get.status} ${get.text}`,
      );
      const prefs = get.json as {
        agentName?: string;
        userName?: string;
        updatedAt?: string;
      } | null;
      assert.ok(
        prefs,
        'GET /user-preferences returned null after the tool ran',
      );
      assert.equal(
        prefs.agentName,
        agentName,
        `agentName not saved: ${get.text}`,
      );
      assert.equal(prefs.userName, userName, `userName not saved: ${get.text}`);
      assert.ok(prefs.updatedAt, `updatedAt missing: ${get.text}`);

      // Hydration: a NEW session (no thread memory) must see the preferred
      // agent name — it reaches the model only through the system prompt.
      const s2 = await c.createSession();
      const r2 = await c.stream(
        s2,
        'What is your name? Reply with the name only, nothing else.',
      );
      assert.ok(
        r2.text.includes(agentName),
        `new session did not honour the preferred agent name "${agentName}": "${r2.text.slice(0, 160)}"`,
      );
    },
  );

  await step(
    'delegation: room state is written in the Node runtime envelope (compressed superjson)',
    async () => {
      assert.ok(
        acct.matrixAccessToken,
        'account JSON has no matrixAccessToken — cannot read room state as the user',
      );
      const res = await fetch(
        `${MATRIX_BASE}/_matrix/client/v3/rooms/${encodeURIComponent(acct.roomId)}/state/ixo.room.state/ucan_delegation`,
        { headers: { Authorization: `Bearer ${acct.matrixAccessToken}` } },
      );
      const text = await res.text();
      assert.equal(res.status, 200, `room state read → ${res.status} ${text}`);
      const content = JSON.parse(text) as { data?: unknown };
      assert.equal(
        typeof content.data,
        'string',
        `expected the {data: base64} envelope, got: ${JSON.stringify(content).slice(0, 200)}`,
      );
      // Decode exactly the way @ixo/matrix MatrixStateManager does.
      const inflated = inflateSync(
        Buffer.from(content.data as string, 'base64'),
      ).toString('utf8');
      const stored = JSON.parse(inflated) as {
        json?: {
          raw?: string;
          issuer?: string;
          audience?: string;
          updatedAt?: string;
        };
      };
      assert.ok(
        stored.json,
        `not a superjson envelope: ${inflated.slice(0, 200)}`,
      );
      assert.equal(typeof stored.json.raw, 'string', 'raw delegation missing');
      assert.equal(
        stored.json.issuer,
        acct.did,
        'issuer should be the user DID',
      );
      assert.equal(
        stored.json.audience,
        ORACLE_DID,
        'audience should be the oracle DID',
      );
      assert.ok(
        stored.json.updatedAt,
        "updatedAt missing (required by Node's schema)",
      );
    },
  );

  // ── delegation lifecycle in the user object ──────────────────────────────
  await step(
    'delegation: revoke clears the user object cache at once; re-deposit restores it',
    async () => {
      const before = await authed(user, 'GET', '/debug/delegation');
      assert.equal(before.status, 200, before.text.slice(0, 200));
      assert.equal(
        (before.json as { present?: boolean }).present,
        true,
        `expected a cached delegation after the deposit: ${before.text}`,
      );
      const del = await authed(user, 'DELETE', '/delegation');
      assert.ok(del.status < 300, del.text.slice(0, 200));
      const after = await authed(user, 'GET', '/debug/delegation');
      assert.equal(
        (after.json as { present?: boolean }).present,
        false,
        `cached delegation survived revocation: ${after.text}`,
      );
      const raw = await mintDelegation(user, ORACLE_DID, [
        { can: '*', with: 'ixo:oracle' },
        { can: '*', with: 'ixo:memory' },
        { can: '*', with: 'ixo:sandbox' },
        { can: '*', with: 'ixo:skills' },
      ]);
      const expiration = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
      const post = await authed(user, 'POST', '/delegation', {
        raw,
        expiration,
      });
      assert.equal(post.status, 200, post.text.slice(0, 200));
      const restored = await authed(user, 'GET', '/debug/delegation');
      const j = restored.json as { present?: boolean; expiration?: number };
      assert.equal(j.present, true, `re-deposit not adopted: ${restored.text}`);
      assert.equal(
        j.expiration,
        expiration,
        `expiration not carried into the cache: ${restored.text}`,
      );
    },
  );

  // ── per-request model override ───────────────────────────────────────────
  await step(
    'models: a per-request platform model is accepted; an unknown id falls back',
    async () => {
      const r = await authed(user, 'GET', '/models');
      const body = r.json as
        | {
            models?: Array<{ id?: string } | string>;
            default?: string | null;
          }
        | Array<{ id?: string } | string>;
      const entries = Array.isArray(body) ? body : (body.models ?? []);
      const ids = entries
        .map((m) => (typeof m === 'string' ? m : m.id))
        .filter((x): x is string => typeof x === 'string');
      const def = Array.isArray(body) ? null : (body.default ?? null);
      const alt = ids.find((id) => id !== def) ?? ids[0];
      assert.ok(alt, `no model ids in ${r.text.slice(0, 200)}`);
      const c = await client();
      const s = await c.createSession();
      const r1 = await c.stream(s, 'Reply with the single word OK.', {
        body: { model: alt },
      });
      assert.equal(r1.status, 200, r1.text.slice(0, 200));
      assert.ok(
        r1.events.some((e) => e.event === 'done'),
        `no done event with model=${alt}: ${r1.text.slice(0, 160)}`,
      );
      const r2 = await c.stream(s, 'Reply with the single word OK.', {
        body: { model: 'nope/does-not-exist' },
      });
      assert.equal(r2.status, 200, r2.text.slice(0, 200));
      assert.ok(
        r2.events.some((e) => e.event === 'done'),
        `unknown model id did not fall back: ${r2.text.slice(0, 160)}`,
      );
    },
  );

  // ── tasks lifecycle tools ────────────────────────────────────────────────
  await step(
    'tasks: list_my_tasks → pause_task → resume_task → cancel_task (status verified)',
    async () => {
      const c = await client();
      const s = await c.createSession();
      const title = `Lifecycle ${tag}`;
      const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await c.stream(
        s,
        `Preview a background task for me (preview_task): title "${title}", schedule kind "once" at exactly "${at}", intent: 'Reply with the word LIFECYCLE'. Then wait for my confirmation.`,
      );
      const created = await c.stream(
        s,
        'Yes, that looks right — call create_task now with exactly the previewed title/intent/schedule, then reply with the task id the tool returned.',
      );
      assert.ok(
        doneTools(created.events).some((t) => /create_task/.test(t)),
        `no create_task call; tools: ${toolCalls(created.events).join(', ') || '(none)'}`,
      );
      const listed = await c.stream(
        s,
        `Call list_my_tasks and tell me the id of the task titled "${title}".`,
      );
      assert.ok(
        doneTools(listed.events).some((t) => /list_my_tasks/.test(t)),
        `no list_my_tasks call; tools: ${toolCalls(listed.events).join(', ') || '(none)'}`,
      );
      for (const [tool, ask] of [
        [
          'pause_task',
          `Call pause_task on the task titled "${title}" and report the result.`,
        ],
        [
          'resume_task',
          `Call resume_task on the task titled "${title}" and report the result.`,
        ],
        [
          'cancel_task',
          `Call cancel_task on the task titled "${title}" and report the result.`,
        ],
      ] as const) {
        const r = await c.stream(s, ask);
        assert.ok(
          doneTools(r.events).some((t) => t.includes(tool)),
          `no ${tool} call; tools: ${toolCalls(r.events).join(', ') || '(none)'}; reply: "${r.text.slice(0, 160)}"`,
        );
      }
      const status = await authed(user, 'GET', '/debug/tasks');
      const tasks =
        (status.json as { tasks?: Array<{ title?: string; status?: string }> })
          .tasks ?? [];
      const mine = tasks.find((t) => t.title === title);
      assert.ok(
        mine,
        `task "${title}" not in /debug/tasks: ${status.text.slice(0, 300)}`,
      );
      assert.match(
        String(mine.status),
        /cancel/i,
        `task not cancelled after cancel_task: ${JSON.stringify(mine)}`,
      );
    },
  );

  // ── vfs list + delete ────────────────────────────────────────────────────
  await step(
    'vfs: vfs_list sees the file; vfs_delete removes it (verified through the VFS API)',
    async () => {
      const c = await client();
      const s = await c.createSession();
      const ask = `First call vfs_list on the folder /devnet-features and tell me whether ${tag}.txt is listed. Then, regardless of the listing result, call vfs_delete on /devnet-features/${tag}.txt and report the tool's result.`;
      const r = await c.stream(s, ask).catch(async (err: unknown) => {
        // A transient network failure on the client side, not the oracle's.
        if (!/fetch failed/i.test(String(err))) throw err;
        return c.stream(s, ask);
      });
      const done = doneTools(r.events);
      assert.ok(
        done.some((t) => /vfs_list/.test(t)),
        `no vfs_list call; tools: ${toolCalls(r.events).join(', ') || '(none)'}`,
      );
      assert.ok(
        done.some((t) => /vfs_delete/.test(t)),
        `no vfs_delete call; tools: ${toolCalls(r.events).join(', ') || '(none)'}`,
      );
      const list = await vfsUserRequest(
        user,
        'fs/list',
        'GET',
        `/files?path=${encodeURIComponent('/devnet-features')}&limit=100`,
        { vfsUrl: VFS_URL },
      ).catch((err: unknown) => {
        throw new Error(`VFS API list failed: ${String(err)}`);
      });
      const files = (await list.json()) as { files?: Array<{ path: string }> };
      assert.ok(
        !(files.files ?? []).some((f) => f.path.endsWith(`/${tag}.txt`)),
        `file still present in VFS after vfs_delete`,
      );
    },
  );

  // ── memory recall across sessions (indexing is async) ───────────────────
  await step(
    'memory-engine: search_memory_engine recalls the stored codename in a new session',
    async () => {
      const c = await client();
      const deadline = Date.now() + 240_000;
      let last = '';
      while (Date.now() < deadline) {
        const s = await c.createSession();
        const r = await c.stream(
          s,
          `Use the memory search tool to find the project codename for ticket ${tag.toUpperCase()} and reply with just that codename.`,
        );
        last = r.text;
        const upstream = toolErrors(r.events);
        assert.equal(
          upstream.length,
          0,
          `memory-engine search errored upstream: ${upstream[0]?.slice(0, 300)} — calls: ${failingToolArgs(r.events).join(' | ').slice(0, 600)}`,
        );
        if (
          doneTools(r.events).some((t) => /search_memory/.test(t)) &&
          r.text.toLowerCase().includes(codename.toLowerCase())
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 20_000));
      }
      assert.fail(
        `codename "${codename}" not recalled within 4 min: "${last.slice(0, 160)}"`,
      );
    },
  );

  // ── session history → memory engine (indexed when the next session is created) ──
  await step(
    'memory-engine: a previous session is indexed on new-session create (recalled in a fresh session)',
    async () => {
      const c = await client();
      const code = `${pick(ADJECTIVES)} ${pick(ANIMALS)} Lumen`;
      const s1 = await c.createSession();
      const told = await c.stream(
        s1,
        `Just so you know, the colour code for order ${tag.toUpperCase()} is ${code}. Do NOT call any memory tool — just acknowledge in one word.`,
      );
      assert.ok(
        !toolCalls(told.events).some((t) => /add_memory/.test(t)),
        'the agent stored the fact explicitly, so this step cannot prove transcript indexing',
      );
      // Creating the next session sends s1's transcript to the memory engine.
      await c.createSession();
      const deadline = Date.now() + 180_000;
      let last = '';
      while (Date.now() < deadline) {
        const s = await c.createSession();
        const r = await c.stream(
          s,
          `Use the memory search tool to find the colour code for order ${tag.toUpperCase()} and reply with just the code.`,
        );
        last = r.text;
        const upstream = toolErrors(r.events);
        assert.equal(
          upstream.length,
          0,
          `memory-engine search errored upstream: ${upstream[0]?.slice(0, 300)} — calls: ${failingToolArgs(r.events).join(' | ').slice(0, 600)}`,
        );
        if (
          doneTools(r.events).some((t) => /search_memory/.test(t)) &&
          r.text.toLowerCase().includes(code.toLowerCase())
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 20_000));
      }
      assert.fail(
        `colour code ${code} from the previous session was not recalled within 3 min: "${last.slice(0, 160)}"`,
      );
    },
  );

  // ── realtime (socket.io) channel: browser tools, AG-UI, page rooms ───────
  /** The room's timeline, oldest first, as the e2e user (raw client API). */
  const roomEvents = async (
    id: string,
  ): Promise<
    Array<{
      type: string;
      sender: string;
      content: Record<string, unknown>;
      event_id?: string;
      origin_server_ts?: number;
    }>
  > => {
    const res = await fetch(
      `${MATRIX_BASE}/_matrix/client/v3/rooms/${encodeURIComponent(id)}/messages?dir=b&limit=500`,
      { headers: { authorization: `Bearer ${mxSession.access_token}` } },
    );
    assert.equal(res.status, 200, `messages ${id} → ${res.status}`);
    const body = (await res.json()) as {
      chunk: Array<{
        type: string;
        sender: string;
        content: Record<string, unknown>;
        event_id?: string;
        origin_server_ts?: number;
      }>;
    };
    return body.chunk.reverse();
  };
  const socketFor = async (sessionId: string, auth: Record<string, unknown>) =>
    SocketIoClient.connect({
      baseUrl: ORACLE_URL,
      sessionId,
      userDid: user.did,
      auth,
    });

  let realtimeSession = '';
  await step(
    'gateway restart: sessions created while the gateway restarts succeed and leave no ghost markers',
    async () => {
      const before = await authed(user, 'GET', '/sessions?limit=1');
      const total0 = (before.json as { total: number }).total;
      const since = Date.now();
      // Kick a restart (stop + start) without waiting for it, then create
      // sessions straight into the restart window.
      void authed(user, 'POST', '/debug/matrix/restart');
      await new Promise((r) => setTimeout(r, 300));
      const results = await Promise.all(
        Array.from({ length: 4 }, () => authed(user, 'POST', '/sessions', {})),
      );
      for (const r of results)
        assert.equal(
          r.status,
          201,
          `create during restart: ${r.status} ${r.text.slice(0, 160)}`,
        );
      const ids = results.map(
        (r) => (r.json as { sessionId: string }).sessionId,
      );
      assert.ok(
        ids.every((id) => id.startsWith('$')),
        `not Matrix ids: ${ids.join(',')}`,
      );
      const after = await authed(user, 'GET', '/sessions?limit=1');
      assert.equal((after.json as { total: number }).total, total0 + 4);
      // Every marker in the room since `since` must belong to one of the
      // sessions created: no orphan marker from a retried send.
      await waitFor(
        async () =>
          (await roomEvents(roomId)).some((e) =>
            ids.includes(e.event_id ?? ''),
          ),
        60_000,
        'markers visible in the room',
        2_000,
      );
      const markers = (await roomEvents(roomId)).filter(
        (e) =>
          e.sender === BOT_USER_ID &&
          (e.origin_server_ts ?? 0) >= since &&
          !e.content['m.relates_to'],
      );
      assert.equal(
        markers.length,
        4,
        `expected exactly 4 new marker events, saw ${markers.length}: ${markers.map((m) => m.event_id).join(',')}`,
      );
      assert.ok(
        markers.every((m) => ids.includes(m.event_id ?? '')),
        'a marker event is not a created session',
      );
    },
  );

  await step(
    'realtime: socket.io handshake → connected; ping/pong, status, list-events; bad/foreign tokens refused',
    async () => {
      const c = await client();
      realtimeSession = await c.createSession();
      const invocation = await mintAuthInvocation(user, ORACLE_DID);
      const { client: sock, outcome } = await socketFor(realtimeSession, {
        invocation,
      });
      assert.ok(
        outcome.ok,
        `connect failed: ${outcome.ok ? '' : outcome.error}`,
      );
      try {
        const connected = await sock.waitFor(
          (e) => e.name === 'connected',
          10_000,
          'connected',
        );
        assert.equal(
          (connected.payload as { sessionId?: string }).sessionId,
          realtimeSession,
        );
        sock.emit('ping');
        await sock.waitFor((e) => e.name === 'pong', 10_000, 'pong');
        sock.emit('status');
        const status = await sock.waitFor(
          (e) => e.name === 'status',
          10_000,
          'status',
        );
        const st = status.payload as {
          connected?: boolean;
          totalConnections?: number;
        };
        assert.equal(st.connected, true);
        assert.ok((st.totalConnections ?? 0) >= 1, JSON.stringify(st));
        sock.emit('list-events');
        const listed = await sock.waitFor(
          (e) => e.name === 'available-events',
          10_000,
          'available-events',
        );
        const server =
          (listed.payload as { serverEvents?: string[] }).serverEvents ?? [];
        for (const name of ['browser_tool_call', 'action_call', 'tool_call'])
          assert.ok(server.includes(name), `available-events lacks ${name}`);
        const debug = await authed(user, 'GET', '/debug/realtime');
        assert.equal(debug.status, 200, debug.text.slice(0, 200));
        assert.ok(
          ((debug.json as { authenticated?: number }).authenticated ?? 0) >= 1,
          `/debug/realtime sees no authenticated socket: ${debug.text.slice(0, 200)}`,
        );
      } finally {
        sock.close();
      }
      const bad = await socketFor(realtimeSession, {
        invocation: 'not-a-ucan',
      });
      assert.ok(!bad.outcome.ok, 'a bogus invocation was accepted');
      assert.match(
        bad.outcome.ok ? '' : bad.outcome.error,
        /Unauthorized|4401/,
      );
      bad.client.close();
      const foreign = await SocketIoClient.connect({
        baseUrl: ORACLE_URL,
        sessionId: realtimeSession,
        userDid: 'did:ixo:ixo1someoneelse',
        auth: { invocation },
      });
      assert.ok(
        !foreign.outcome.ok,
        "a token was accepted for another user's object",
      );
      assert.match(
        foreign.outcome.ok ? '' : foreign.outcome.error,
        /does not belong|Unauthorized|4401/,
      );
      foreign.client.close();
      const noSession = await socketFor('no-such-session', { invocation });
      assert.ok(
        !noSession.outcome.ok,
        'a socket to an unknown session was accepted',
      );
      noSession.client.close();
    },
  );

  await step(
    'realtime: an idle socket lets the object unload (hibernation) and still works afterwards',
    async () => {
      // The socket must not keep the object resident: pings come from the
      // object's alarm (every 3 minutes), so between them the platform
      // unloads it. `/debug/storage` on a freshly woken object reports
      // fileBytes 0 (no database open yet) — the unload signal. The socket
      // itself survives (Hibernatable WebSockets) and is re-adopted.
      // Reuses the handshake step's session; creates one when that step was
      // filtered out (STEP_FILTER), so this step also runs on its own.
      const session =
        realtimeSession || (await (await client()).createSession());
      const invocation = await mintAuthInvocation(user, ORACLE_DID);
      const { client: sock, outcome } = await socketFor(session, {
        invocation,
      });
      assert.ok(
        outcome.ok,
        `connect failed: ${outcome.ok ? '' : outcome.error}`,
      );
      try {
        await sock.waitFor((e) => e.name === 'connected', 10_000, 'connected');
        // Background work keeps an object loaded legitimately — the streamed
        // flush of a multi-MB file after the earlier steps, for one. Let it
        // finish before measuring the idle unload.
        await waitFor(
          async () => {
            const s = await authed(user, 'GET', '/debug/storage');
            const j = s.json as {
              flushInFlight?: boolean;
              indexingInFlight?: number;
              activeTurns?: number;
              pendingTimers?: number;
            };
            return (
              s.status === 200 &&
              j.flushInFlight !== true &&
              (j.indexingInFlight ?? 0) === 0 &&
              (j.activeTurns ?? 0) === 0 &&
              (j.pendingTimers ?? 0) === 0
            );
          },
          180_000,
          'the background flush to finish before idling',
          5000,
        );
        await new Promise((r) => setTimeout(r, 30_000));
        assert.ok(
          !sock.isClosed,
          `socket closed while idle: ${JSON.stringify(sock.closeInfo)}`,
        );
        const storage = await authed(user, 'GET', '/debug/storage');
        assert.equal(storage.status, 200, storage.text.slice(0, 200));
        if ((storage.json as { fileBytes?: number }).fileBytes !== 0) {
          // Resident: show what holds it (timers with their creation
          // stacks) before failing, so the log names the culprit.
          const rt = await authed(user, 'GET', '/debug/realtime');
          console.log(
            `    [hibernation] resident object; /debug/realtime: ${rt.text.slice(0, 1500)}`,
          );
        }
        assert.equal(
          (storage.json as { fileBytes?: number }).fileBytes,
          0,
          `object stayed resident with an idle socket attached (fileBytes ${
            (storage.json as { fileBytes?: number }).fileBytes
          }): ${storage.text.slice(0, 400)}`,
        );
        const rt = await authed(user, 'GET', '/debug/realtime');
        assert.equal(rt.status, 200, rt.text.slice(0, 200));
        const status = rt.json as {
          nextPingAt?: number | null;
          pingIntervalMs?: number;
          socketDetails?: Array<{ sessionId: string; authenticated: boolean }>;
        };
        assert.equal(status.pingIntervalMs, 180_000, rt.text.slice(0, 200));
        assert.ok(
          status.socketDetails?.some(
            (d) => d.sessionId === session && d.authenticated,
          ),
          `re-adopted socket missing from /debug/realtime: ${rt.text.slice(0, 300)}`,
        );
        assert.ok(
          typeof status.nextPingAt === 'number' &&
            status.nextPingAt > Date.now(),
          `no future heartbeat deadline: ${rt.text.slice(0, 200)}`,
        );
        // A turn on the session must still fan out to the re-adopted socket.
        const c = await client();
        const r = await c.stream(
          session,
          'Call the list_capabilities tool and reply with the name of one capability.',
        );
        assert.ok(
          doneTools(r.events).includes('list_capabilities'),
          `no list_capabilities call; tools: ${toolCalls(r.events).join(', ') || '(none)'}`,
        );
        await sock.waitFor(
          (e) => e.name === 'tool_call',
          15_000,
          'a tool_call event on the re-adopted socket',
        );
        sock.emit('ping');
        await sock.waitFor((e) => e.name === 'pong', 10_000, 'pong after wake');
      } finally {
        sock.close();
      }
    },
  );

  await step(
    'realtime: a client-declared browser tool runs in the "browser" and its result reaches the model',
    async () => {
      const c = await client();
      const s = realtimeSession || (await c.createSession());
      const invocation = await mintAuthInvocation(user, ORACLE_DID);
      const { client: sock, outcome } = await socketFor(s, { invocation });
      assert.ok(
        outcome.ok,
        `connect failed: ${outcome.ok ? '' : outcome.error}`,
      );
      const secret = `BROWSER-${tag}-${Math.random().toString(36).slice(2, 6)}`;
      const served: string[] = [];
      const stop = sock.serveFrontendTools(async ({ toolName, args }) => {
        served.push(`${toolName}:${JSON.stringify(args)}`);
        if (toolName === 'get_browser_secret') return { secret };
        throw new Error(`unexpected tool ${toolName}`);
      });
      try {
        const r = await c.stream(
          s,
          'Call the get_browser_secret browser tool now and reply with ONLY the exact secret string it returns, nothing else.',
          {
            body: {
              tools: [
                {
                  name: 'get_browser_secret',
                  description:
                    "Returns the secret string currently shown in the user's browser tab. Call it whenever the user asks for the browser secret.",
                  schema: {
                    type: 'object',
                    properties: {},
                    additionalProperties: false,
                  },
                },
              ],
            },
          },
        );
        assert.ok(
          doneTools(r.events).includes('get_browser_secret'),
          `no get_browser_secret call; tools: ${toolCalls(r.events).join(', ') || '(none)'}; errors: ${toolErrors(r.events).join(' | ')}; reply: "${r.text.slice(0, 200)}"`,
        );
        assert.ok(
          served.length >= 1,
          'the browser never received browser_tool_call',
        );
        assert.ok(
          sock.events.some((e) => e.name === 'browser_tool_call'),
          `socket saw no browser_tool_call; events: ${sock.events.map((e) => e.name).join(', ')}`,
        );
        assert.ok(
          r.text.includes(secret),
          `reply lacks the browser secret ${secret}: "${r.text.slice(0, 200)}"`,
        );
      } finally {
        stop();
        sock.close();
      }
    },
  );

  await step(
    'realtime: an AG-UI action runs through call_ag-ui_agent and its result returns from the browser',
    async () => {
      const c = await client();
      const s = await c.createSession();
      const invocation = await mintAuthInvocation(user, ORACLE_DID);
      const { client: sock, outcome } = await socketFor(s, { invocation });
      assert.ok(
        outcome.ok,
        `connect failed: ${outcome.ok ? '' : outcome.error}`,
      );
      const served: Array<{ toolName: string; args: Record<string, unknown> }> =
        [];
      const stop = sock.serveFrontendTools(async ({ kind, toolName, args }) => {
        served.push({ toolName, args });
        if (kind === 'agui' && toolName === 'render_greeting_card')
          return { success: true, rendered: `card:${String(args.title)}` };
        throw new Error(`unexpected ${kind} tool ${toolName}`);
      });
      try {
        const cardTitle = `Hello ${tag}`;
        const r = await c.stream(
          s,
          `Render a greeting card titled "${cardTitle}" with the message "welcome" — use the AG-UI agent (call_ag-ui_agent) and its render_greeting_card action. When it is rendered, reply with the single word RENDERED.`,
          {
            body: {
              agActions: [
                {
                  name: 'render_greeting_card',
                  description:
                    'Render a greeting card component in the UI with the given title and message.',
                  schema: {
                    type: 'object',
                    properties: {
                      title: { type: 'string' },
                      message: { type: 'string' },
                    },
                    required: ['title', 'message'],
                  },
                  hasRender: true,
                },
              ],
            },
          },
        );
        assert.ok(
          doneTools(r.events).some((t) => /ag-ui|agui/.test(t)),
          `no call_ag-ui_agent call; tools: ${toolCalls(r.events).join(', ') || '(none)'}; reply: "${r.text.slice(0, 200)}"`,
        );
        const action = sock.events.find((e) => e.name === 'action_call');
        assert.ok(
          action,
          `socket saw no action_call; events: ${sock.events.map((e) => e.name).join(', ')}`,
        );
        assert.equal(
          (action.payload as { toolName?: string }).toolName,
          'render_greeting_card',
        );
        assert.ok(
          served.some(
            (x) =>
              x.toolName === 'render_greeting_card' &&
              x.args.title === cardTitle,
          ),
          `browser served: ${JSON.stringify(served)}`,
        );
        assert.match(r.text, /RENDERED/i);
      } finally {
        stop();
        sock.close();
      }
    },
  );

  await step(
    'realtime: create_page_room (browser tool) → the editor writes into the new page (CRDT updates replayed with yjs)',
    async () => {
      const c = await client();
      const s = await c.createSession();
      const invocation = await mintAuthInvocation(user, ORACLE_DID);
      const { client: sock, outcome } = await socketFor(s, { invocation });
      assert.ok(
        outcome.ok,
        `connect failed: ${outcome.ok ? '' : outcome.error}`,
      );
      const pageTitle = `E2E page ${tag}`;
      const sentence = `The quick brown fox jumps over the lazy dog ${tag}.`;
      let pageRoomId = '';
      const stop = sock.serveFrontendTools(async ({ toolName, args }) => {
        if (toolName !== 'create_page_room')
          throw new Error(`unexpected tool ${toolName}`);
        // What the Portal's create_page_room does: a collaborative BlockNote
        // room owned by the user, the assistant invited at power level 60.
        // `oracleUserId` is hidden from the model and injected by the runtime.
        assert.equal(
          args.oracleUserId,
          BOT_USER_ID,
          `oracleUserId was not injected by the runtime: ${JSON.stringify(args)}`,
        );
        const res = await mx.createRoom({
          name:
            typeof args.title === 'string' && args.title
              ? args.title
              : 'New page',
          topic: 'Page created by the assistant',
          visibility: sdk.Visibility.Private,
          invite: [BOT_USER_ID],
          initial_state: [
            {
              type: 'm.room.history_visibility',
              state_key: '',
              content: { history_visibility: 'shared' },
            },
            {
              type: 'm.room.guest_access',
              state_key: '',
              content: { guest_access: 'forbidden' },
            },
          ],
          power_level_content_override: {
            events_default: 50,
            state_default: 50,
            ban: 50,
            kick: 50,
            redact: 50,
            invite: 50,
            users_default: 0,
            users: { [mxSession.user_id]: 100, [BOT_USER_ID]: 60 },
            events: {
              'com.yjs.webrtc.announce': 0,
              'com.yjs.webrtc.signal': 0,
            },
          },
        });
        pageRoomId = res.room_id;
        return {
          success: true,
          roomId: pageRoomId,
          placedIn: 'personal',
          opened: true,
        };
      });
      try {
        const r = await c.stream(
          s,
          `Create a new page titled "${pageTitle}" with the create_page_room browser tool. Then use the document assistant (call_editor_agent) with the room id it returned to write exactly this sentence into the page as a paragraph: "${sentence}". Finally reply with the room id.`,
          {
            body: {
              tools: [
                {
                  name: 'create_page_room',
                  description:
                    "Create a new, empty page and open it in the editor. Inside a domain the page is added to that domain when the user may add pages there, otherwise to the user's personal workspace — `placedIn` and `fallbackReason` say which. Returns the room id to write content into.",
                  schema: {
                    type: 'object',
                    properties: {
                      title: { type: 'string' },
                      oracleUserId: { type: 'string' },
                    },
                  },
                },
              ],
            },
          },
        );
        assert.ok(
          doneTools(r.events).includes('create_page_room'),
          `no create_page_room call; tools: ${toolCalls(r.events).join(', ') || '(none)'}; reply: "${r.text.slice(0, 200)}"`,
        );
        assert.ok(
          pageRoomId,
          'the browser was never asked to create the page room',
        );
        assert.ok(
          doneTools(r.events).some((t) => /editor/.test(t)),
          `no editor tool call after the page was created; tools: ${toolCalls(r.events).join(', ')}; errors: ${toolErrors(r.events).join(' | ')}; reply: "${r.text.slice(0, 200)}"`,
        );
        // Independent verification: replay every CRDT update the room holds
        // (the assistant's included) into a fresh Y.Doc and read the page.
        let botUpdates = 0;
        let lastText = '';
        await waitFor(
          async () => {
            const events = await roomEvents(pageRoomId);
            const crdt = events.filter(
              (e) =>
                (e.type === 'matrix-crdt.doc_update' ||
                  e.type === 'matrix-crdt.doc_snapshot') &&
                typeof e.content.update === 'string',
            );
            botUpdates = crdt.filter((e) => e.sender === BOT_USER_ID).length;
            const doc = new Y.Doc();
            for (const e of crdt)
              Y.applyUpdate(
                doc,
                Buffer.from(String(e.content.update), 'base64'),
              );
            lastText = `${doc.getXmlFragment('document').toString()} ${doc.getText('title').toString()}`;
            return lastText.includes(sentence);
          },
          90_000,
          `the sentence to appear in the page CRDT (last text: ${lastText.slice(0, 200)})`,
          3000,
        );
        assert.ok(
          botUpdates >= 1,
          'no CRDT update in the page was sent by the assistant',
        );
        assert.ok(
          r.text.includes(pageRoomId),
          `reply lacks the room id ${pageRoomId}: "${r.text.slice(0, 200)}"`,
        );
      } finally {
        stop();
        sock.close();
      }
    },
  );

  await step(
    'tasks: dedicatedRoom=yes → "[Task] <title>" room created, user invited, summary posted there',
    async () => {
      const c = await client();
      const s = await c.createSession();
      const title = `Roomed ${tag}`;
      const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await c.stream(
        s,
        `Preview a background task for me (preview_task): title "${title}", schedule kind "once" at exactly "${at}", intent: 'Reply with the word ROOMED.'`,
      );
      const created = await c.stream(
        s,
        'Yes, that looks right — call create_task now with exactly the previewed title/intent/schedule and dedicatedRoom set to "yes" (I want this task to have its own room), then reply with the task id the tool returned.',
      );
      assert.ok(
        doneTools(created.events).includes('create_task'),
        `no create_task call; tools: ${toolCalls(created.events).join(', ') || '(none)'}`,
      );
      const status = await authed(user, 'GET', '/debug/tasks');
      const tasks =
        (
          status.json as {
            tasks?: Array<{
              title?: string;
              status?: string;
              deliveryRoomId?: string | null;
            }>;
          }
        ).tasks ?? [];
      const mine = tasks.find((t) => t.title === title);
      assert.ok(
        mine,
        `task "${title}" not in /debug/tasks: ${status.text.slice(0, 300)}`,
      );
      const taskRoomId = mine.deliveryRoomId ?? '';
      assert.match(
        taskRoomId,
        /^!/,
        `task has no dedicated room: ${JSON.stringify(mine)}`,
      );
      try {
        // The bot invited the user; accept as the Portal would, then read the
        // summary. Plain client API here: the syncing `mx` client of the
        // Matrix block is stopped by now, and a join needs no sync.
        const mxRest = async (method: string, path: string) => {
          const res = await fetch(`${MATRIX_BASE}/_matrix/client/v3${path}`, {
            method,
            headers: {
              authorization: `Bearer ${mxSession.access_token}`,
              'content-type': 'application/json',
            },
            ...(method === 'POST' ? { body: '{}' } : {}),
          });
          const text = await res.text();
          return { status: res.status, json: text ? JSON.parse(text) : {} };
        };
        const encodedRoom = encodeURIComponent(taskRoomId);
        await waitFor(
          async () =>
            (await mxRest('POST', `/join/${encodedRoom}`)).status === 200,
          60_000,
          `the invite to ${taskRoomId}`,
        );
        let roomName = '';
        await waitFor(
          async () => {
            const r = await mxRest(
              'GET',
              `/rooms/${encodedRoom}/state/m.room.name/`,
            );
            roomName = String((r.json as { name?: string }).name ?? '');
            return roomName === `[Task] ${title}`;
          },
          30_000,
          `room name "[Task] ${title}" (got "${roomName}")`,
        );
        let events: Awaited<ReturnType<typeof roomEvents>> = [];
        await waitFor(
          async () => {
            events = await roomEvents(taskRoomId);
            return events.some(
              (e) =>
                e.sender === BOT_USER_ID &&
                e.type === 'm.room.message' &&
                String(e.content.body ?? '').includes(title),
            );
          },
          30_000,
          `the bot's task summary in ${taskRoomId}`,
        );
        assert.ok(
          events.some(
            (e) =>
              e.sender === BOT_USER_ID &&
              e.type === 'm.room.message' &&
              String(e.content.body ?? '').includes(title),
          ),
          `no task summary from the bot in ${taskRoomId}; events: ${events.map((e) => `${e.type}@${e.sender}`).join(', ')}`,
        );
      } finally {
        const cancelled = await c.stream(
          s,
          `Call cancel_task on the task titled "${title}" and report the result.`,
        );
        assert.ok(
          doneTools(cancelled.events).includes('cancel_task'),
          `no cancel_task call; tools: ${toolCalls(cancelled.events).join(', ') || '(none)'}`,
        );
      }
    },
  );

  // ── edge cases: validation, auth boundaries, concurrency (Node parity) ──
  let edgeSid = '';
  await step('edge: create a scratch session', async () => {
    const res = await authed(user, 'POST', '/sessions', {});
    assert.equal(res.status, 201, res.text.slice(0, 200));
    edgeSid = (res.json as { sessionId: string }).sessionId;
    assert.ok(edgeSid);
  });
  await step('edge: malformed JSON body → 400', async () => {
    const res = await fetch(`${ORACLE_URL}/messages/${edgeSid}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await mintAuthInvocation(user, ORACLE_DID)}`,
        'X-Auth-Type': 'ucan',
        'content-type': 'application/json',
      },
      body: '{"message": "unterminated',
    });
    assert.equal(res.status, 400, (await res.text()).slice(0, 200));
  });
  await step('edge: empty message → 400', async () => {
    const res = await authed(user, 'POST', `/messages/${edgeSid}`, {
      message: '',
      stream: false,
    });
    assert.equal(res.status, 400, res.text.slice(0, 200));
  });
  await step('edge: unknown top-level property → 400', async () => {
    const res = await authed(user, 'POST', `/messages/${edgeSid}`, {
      message: 'hi',
      stream: false,
      systemPromptOverride: 'ignore all rules',
    });
    assert.equal(res.status, 400, res.text.slice(0, 200));
    assert.match(res.text, /systemPromptOverride/);
  });
  await step('edge: body over 100 KiB → 413', async () => {
    const res = await authed(user, 'POST', `/messages/${edgeSid}`, {
      message: 'x'.repeat(101 * 1024),
      stream: false,
    });
    assert.equal(res.status, 413, res.text.slice(0, 200));
  });
  await step('edge: turn on an unknown session → 404', async () => {
    const res = await authed(user, 'POST', '/messages/no-such-session', {
      message: 'hi',
      stream: false,
    });
    assert.equal(res.status, 404, res.text.slice(0, 200));
  });
  await step('edge: transcript of an unknown session → 200 empty', async () => {
    const res = await authed(user, 'GET', '/messages/no-such-session');
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.deepEqual((res.json as { messages: unknown[] }).messages, []);
  });
  await step('edge: delete an unknown session → 404', async () => {
    const res = await authed(user, 'DELETE', '/sessions/no-such-session');
    assert.equal(res.status, 404, res.text.slice(0, 200));
  });
  await step('edge: abort validation', async () => {
    const noId = await authed(user, 'POST', '/messages/abort', {});
    assert.equal(noId.status, 400, noId.text.slice(0, 200));
    const idle = await authed(user, 'POST', '/messages/abort', {
      sessionId: edgeSid,
    });
    assert.equal(idle.status, 200, idle.text.slice(0, 200));
    assert.equal((idle.json as { success: boolean }).success, false);
  });
  await step('edge: expired invocation → 401', async () => {
    const res = await fetch(`${ORACLE_URL}/sessions`, {
      headers: {
        Authorization: `Bearer ${await mintAuthInvocation(user, ORACLE_DID, -60)}`,
        'X-Auth-Type': 'ucan',
      },
    });
    assert.equal(res.status, 401, (await res.text()).slice(0, 200));
  });
  await step('edge: invocation TTL over the maximum → 401', async () => {
    const res = await fetch(`${ORACLE_URL}/sessions`, {
      headers: {
        Authorization: `Bearer ${await mintAuthInvocation(user, ORACLE_DID, 24 * 3600)}`,
        'X-Auth-Type': 'ucan',
      },
    });
    assert.equal(res.status, 401, (await res.text()).slice(0, 200));
  });
  await step(
    'edge: 20 KB unicode message round-trips into the transcript',
    async () => {
      const marker = `Ω-${Date.now()}-😀-漢字-mañana`;
      const filler = 'ünïcödé 🚀 '.repeat(1800);
      const res = await authed(user, 'POST', `/messages/${edgeSid}`, {
        message: `Reply with OK only. Marker: ${marker}\n${filler}`,
        stream: false,
      });
      assert.equal(res.status, 200, res.text.slice(0, 200));
      const tx = await authed(user, 'GET', `/messages/${edgeSid}`);
      assert.equal(tx.status, 200);
      assert.ok(tx.text.includes(marker), 'marker missing from transcript');
      assert.ok(tx.text.includes('ünïcödé 🚀'), 'filler mangled');
    },
  );
  await step(
    'edge: a second turn on one session supersedes the first (Node: one in-flight stream per session)',
    async () => {
      // Node's sse-stream-runner aborts the existing controller for the
      // session before registering the new one; the user object does the same.
      const first = authed(user, 'POST', `/messages/${edgeSid}`, {
        message: 'Count slowly from 1 to 40, one number per line.',
        stream: false,
      });
      await new Promise((r) => setTimeout(r, 1500));
      const second = await authed(user, 'POST', `/messages/${edgeSid}`, {
        message: 'Reply with BRAVO-2 only.',
        stream: false,
      });
      const firstRes = await first;
      assert.equal(second.status, 200, second.text.slice(0, 200));
      const tx = await authed(user, 'GET', `/messages/${edgeSid}`);
      assert.ok(
        tx.text.includes('BRAVO-2'),
        `superseding turn missing from the transcript (first: ${firstRes.status} ${firstRes.text.slice(0, 80)})`,
      );
      const st = await authed(user, 'GET', '/debug/storage');
      assert.equal(
        (st.json as { activeTurns: number }).activeTurns,
        0,
        `turns still active after both settled: ${st.text.slice(0, 120)}`,
      );
    },
  );
  await step("edge: another user cannot see this user's sessions", async () => {
    const otherFile = `${SCRATCH}/devnet-user-2.json`;
    if (!existsSync(otherFile))
      throw new Error(
        `${otherFile} missing (create it with devnet-mig-account.mjs)`,
      );
    const o = JSON.parse(readFileSync(otherFile, 'utf8')) as Record<
      string,
      string
    >;
    const other: HarnessAccount = {
      ...user,
      name: 'other',
      address: o.address!,
      did: o.did!,
      edSigningMnemonic: o.edSigningMnemonic!,
      matrixUserId: o.matrixUserId!,
      matrixPassword: o.matrixPassword!,
    };
    // The other user needs a file-storage grant of their own before their
    // object can boot; without one GET /sessions is a 403 (next step).
    await depositVfsDelegation(other, ORACLE_DID, UCAN_STORE);
    const list = await authed(other, 'GET', '/sessions');
    assert.equal(list.status, 200, list.text.slice(0, 200));
    const ids = (
      (list.json as { sessions: { sessionId: string }[] }).sessions ?? []
    ).map((s) => s.sessionId);
    assert.ok(!ids.includes(edgeSid), "other user lists this user's session");
    const tx = await authed(other, 'GET', `/messages/${edgeSid}`);
    assert.deepEqual(
      (tx.json as { messages: unknown[] }).messages,
      [],
      "other user read this user's transcript",
    );
    const turn = await authed(other, 'POST', `/messages/${edgeSid}`, {
      message: 'hi',
      stream: false,
    });
    assert.equal(
      turn.status,
      404,
      `other user could turn on this user's session: ${turn.status}`,
    );
  });
  await step(
    'edge: a user with no file-storage grant gets 403 NO_VFS_DELEGATION over RPC routes',
    async () => {
      const file = `${SCRATCH}/devnet-user-6.json`;
      if (!existsSync(file))
        throw new Error(
          `${file} missing (create it with devnet-mig-account.mjs)`,
        );
      const o = JSON.parse(readFileSync(file, 'utf8')) as Record<
        string,
        string
      >;
      const ungranted: HarnessAccount = {
        ...user,
        name: 'ungranted',
        address: o.address!,
        did: o.did!,
        edSigningMnemonic: o.edSigningMnemonic!,
        matrixUserId: o.matrixUserId!,
        matrixPassword: o.matrixPassword!,
      };
      // GET /sessions reaches the object over RPC (not fetch): the typed
      // owner-copy error must survive the RPC boundary and map to 403.
      const list = await authed(ungranted, 'GET', '/sessions');
      assert.equal(list.status, 403, list.text.slice(0, 200));
      const body = list.json as { code?: string; retryable?: boolean };
      assert.equal(body.code, 'NO_VFS_DELEGATION');
      assert.equal(body.retryable, false);
      // The fetch path (a turn) answers the same way.
      const turn = await authed(ungranted, 'POST', '/messages/any-session', {
        message: 'hi',
        stream: false,
      });
      assert.equal(turn.status, 403, turn.text.slice(0, 200));
      assert.equal((turn.json as { code?: string }).code, 'NO_VFS_DELEGATION');
    },
  );
  await step('edge: cleanup scratch session', async () => {
    const res = await authed(user, 'DELETE', `/sessions/${edgeSid}`);
    assert.equal(res.status, 200, res.text.slice(0, 200));
  });

  await step(
    'realtime: closing the last socket indexes the session (lastProcessedCount advances)',
    async () => {
      const c = await client();
      const sessionId = await c.createSession();
      const r = await c.send(sessionId, 'Reply with exactly: DRAINED');
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      const processedCount = async (): Promise<number> => {
        // The public listing never carries `lastProcessedCount`; the debug
        // row does.
        const row = await authed(
          user,
          'GET',
          `/debug/sessions/${encodeURIComponent(sessionId)}`,
        );
        assert.equal(row.status, 200, row.text.slice(0, 200));
        return (
          (row.json as { lastProcessedCount?: number }).lastProcessedCount ?? 0
        );
      };
      assert.equal(
        await processedCount(),
        0,
        'the session was indexed before any socket closed',
      );
      // Node indexes a session when its last socket disconnects; the
      // Workers object does the same from the realtime endpoint's drain hook.
      const invocation = await mintAuthInvocation(user, ORACLE_DID);
      const sock = await socketFor(sessionId, { invocation });
      assert.ok(
        sock.outcome.ok,
        `socket refused: ${sock.outcome.ok ? '' : sock.outcome.error}`,
      );
      sock.client.close();
      await waitFor(
        async () => (await processedCount()) >= 2,
        90_000,
        'lastProcessedCount to advance after the last socket closed',
        3_000,
      );
    },
  );

  await step(
    'rate limit: burst of cheap requests trips 429 for this user',
    async () => {
      const invocation = await mintAuthInvocation(user, ORACLE_DID);
      // GET /sessions is the cheapest AUTHENTICATED route: /models and
      // /health are auth-excluded and deliberately bypass the limiter. The
      // burst is concurrent so all 120 requests land inside one 60 s window
      // even over a slow link (the limit is 100 per 60 s per user DID).
      // Cloudflare's limiter is approximate and per location/isolate: a
      // concurrent burst spreads over connections and slips through, so the
      // requests go out sequentially on one keep-alive connection. 120 fast
      // requests must trip the 100/60 s limit; if the link is so slow that
      // the window slides first, say so instead of blaming the limiter.
      const t0 = Date.now();
      const statuses: number[] = [];
      for (let i = 0; i < 120 && !statuses.includes(429); i += 1) {
        const res = await fetch(`${ORACLE_URL}/sessions`, {
          headers: {
            Authorization: `Bearer ${invocation}`,
            'X-Auth-Type': 'ucan',
          },
        });
        await res.text();
        statuses.push(res.status);
      }
      const elapsed = Date.now() - t0;
      assert.ok(
        statuses.includes(429) || elapsed <= 45_000,
        `no 429 in ${statuses.length} requests but the link is too slow to test the 60 s window (${Math.round(elapsed / statuses.length)} ms/request)`,
      );
      assert.ok(
        statuses.includes(429),
        `never saw a 429 in ${statuses.length} requests in ${elapsed} ms (statuses: ${[...new Set(statuses)].join(',')})`,
      );
    },
  );

  const failed = results.filter((r) => !r.ok);
  console.log('\n=== devnet feature matrix ===');
  for (const r of results)
    console.log(
      `${r.ok ? '✔' : '✘'} ${r.name} (${r.ms} ms)${r.detail ? `\n    ${r.detail.slice(0, 300)}` : ''}`,
    );
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
