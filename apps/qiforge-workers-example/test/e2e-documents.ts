/**
 * End-to-end test of the oracle document tools (memory plugin) against the
 * local harness:
 *
 *   pnpm test:e2e:documents
 *   MOCK_MCP_PORT=34676 pnpm test:e2e:documents   # when 34675 is taken
 *   ORACLE_PORT=8799 pnpm test:e2e:documents      # when 8787 is taken
 *
 * Boots the in-process mock Memory Engine (`lib/mock-mcp.ts`; its
 * `/knowledge/documents` routes validate the engine contract and record every
 * request) and proves, with a real LLM and a real chat attachment (a text file
 * uploaded to the harness Synapse and attached by its mxc URI):
 *
 *   1. `add_oracle_document` with group_as_document true writes ONE grouped
 *      document (id, title, the file's text, UCAN headers and
 *      `x-oracle-entity-did`);
 *   2. `list_oracle_documents` reads it back;
 *   3. `add_oracle_document` with group_as_document false writes loose
 *      chunks and no document;
 *   4. `delete_oracle_document` removes the grouped document.
 *
 * The model's tool choice is probabilistic, so the prompts give the exact
 * JSON arguments of each call, each turn is capped at 120 s, the model is
 * pinned (`DEFAULT_MODEL`, else the runtime default) and the drill asserts
 * the three tools are offered (the per-turn `tool surface` log line), that
 * `memory-engine__add_oracle_knowledge` was never used for a file, and that
 * the mock engine saw the exact bodies. The mock enforces the engine's
 * entity-DID shape, `x-room-id`, the 900 KB cap and the asynchronous delete.
 *
 * Two modes. MOCK (default): the in-process mock engine above, verified
 * through `mock.state`. LIVE: set BOTH `MEMORY_ENGINE_URL` and `MEMORY_MCP_URL`
 * (plus `MEMORY_SERVICE_API_KEY` and a real `ORACLE_ENTITY_DID`, a
 * `did:ixo:entity:…` whose controller is the harness `tester` user and which
 * lists the oracle account as admin); no mock is started, the user is the
 * harness `tester`, and every outcome is verified through the real engine's
 * REST API (`GET /knowledge/documents` with the service-key headers
 * `x-service-api-key`, `x-user-did`, `x-oracle-did`, `x-room-id`,
 * `x-oracle-entity-did`), polling until the document is `ready` (5 min), then
 * a fresh session's question about a fact from the document must be answered
 * through `search_memory_engine` (the e2e-mcp round trip).
 *
 * `ORACLE_ENTITY_DID` comes from the environment when it has the entity
 * shape; otherwise the drill uses `did:ixo:entity:` plus 32 hex digits
 * derived from the oracle account address (never the account DID itself).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ChatClient } from './lib/chat-client';
import {
  MATRIX_BASE_URL,
  ensureNamedAccount,
  STATIC_ACCOUNTS,
  matrixLogin,
  mintAuthInvocation,
  mintDelegation,
  type MatrixSession,
} from './lib/harness';
import { ensureUserOracleRoom } from './lib/matrix-room';
import { startMockMcpServer } from './lib/mock-mcp';
import { makePdf } from '../../../packages/oracle-runtime-workers/src/attachments/fixtures/make-pdf';
import {
  BOT_USER_ID,
  ORACLE_DID,
  provisionDevVars,
  startOracle,
  waitForMatrixGateway,
} from './lib/oracle';

const MOCK_MCP_PORT = Number(process.env.MOCK_MCP_PORT ?? 34675);
/** Each model turn gets this long. */
const TURN_TIMEOUT_MS = 120_000;
/** The runtime's default main model (`DEFAULT_MODEL_ID`), unless the env pins another. */
const RUNTIME_DEFAULT_MODEL = 'openai/gpt-5.6-luna';
const ENTITY_DID_PATTERN = /^did:ixo:entity:[0-9a-f]{32}$/;

/** `ORACLE_ENTITY_DID` from the env if it is entity-shaped, else a placeholder derived from the account address. */
function entityDidFor(accountDid: string): string {
  const fromEnv = process.env.ORACLE_ENTITY_DID;
  if (fromEnv && ENTITY_DID_PATTERN.test(fromEnv)) return fromEnv;
  const hex = createHash('sha256')
    .update(accountDid.replace(/^did:ixo:/, ''))
    .digest('hex')
    .slice(0, 32);
  return `did:ixo:entity:${hex}`;
}

const results: Array<{
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}> = [];
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  process.stdout.write(`▶ ${name} … `);
  try {
    const out = await fn();
    results.push({ name, ok: true, ms: Date.now() - start });
    console.log(`ok (${Date.now() - start} ms)`);
    return out;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, ms: Date.now() - start, detail });
    console.log(`FAILED (${Date.now() - start} ms)\n    ${detail}`);
    throw err;
  }
}

/** Upload a text file to the harness Synapse as `session`; returns its mxc URI. */
async function uploadText(
  session: MatrixSession,
  filename: string,
  text: string,
): Promise<{ mxcUri: string; size: number }> {
  const bytes = new TextEncoder().encode(text);
  const res = await fetch(
    `${MATRIX_BASE_URL}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        'content-type': 'text/plain',
      },
      body: bytes,
    },
  );
  if (!res.ok)
    throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  const body: unknown = await res.json();
  const uri =
    typeof body === 'object' && body !== null && 'content_uri' in body
      ? body.content_uri
      : undefined;
  assert.equal(
    typeof uri,
    'string',
    `no content_uri in ${JSON.stringify(body)}`,
  );
  return { mxcUri: String(uri), size: bytes.length };
}

function attachmentBody(
  mxcUri: string,
  filename: string,
  size: number,
  mimetype = 'text/plain',
) {
  return {
    attachments: [{ mxcUri, filename, mimetype, size }],
  };
}

/** Upload raw bytes (e.g. a PDF) to the harness Synapse as `session`; returns its mxc URI. */
async function uploadBytes(
  session: MatrixSession,
  filename: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ mxcUri: string; size: number }> {
  const res = await fetch(
    `${MATRIX_BASE_URL}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        'content-type': contentType,
      },
      body: bytes,
    },
  );
  if (!res.ok)
    throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  const body: unknown = await res.json();
  const uri =
    typeof body === 'object' && body !== null && 'content_uri' in body
      ? body.content_uri
      : undefined;
  assert.equal(
    typeof uri,
    'string',
    `no content_uri in ${JSON.stringify(body)}`,
  );
  return { mxcUri: String(uri), size: bytes.length };
}

/** What the document tools answered in a session, for failure messages. */
async function toolOutputs(
  client: ChatClient,
  baseUrl: string,
  sessionId: string,
): Promise<string> {
  const res = await fetch(
    `${baseUrl}/messages/${encodeURIComponent(sessionId)}`,
    { headers: client.headers() },
  );
  const body: unknown = await res.json();
  const messages =
    typeof body === 'object' && body !== null && 'messages' in body
      ? body.messages
      : [];
  if (!Array.isArray(messages)) return '(no transcript)';
  return messages
    .flatMap((m) =>
      typeof m === 'object' && m !== null && 'toolCalls' in m
        ? Array.isArray(m.toolCalls)
          ? m.toolCalls
          : []
        : [],
    )
    .map((c) => JSON.stringify(c).slice(0, 400))
    .join(' | ');
}

const POLL_MS = 3_000;
const READY_TIMEOUT_MS = 5 * 60_000;

async function pollUntil<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

interface LiveDocument {
  id: string;
  title: string;
  status: string;
}

/** The real engine's grouped documents of one space, read with the service key. */
async function liveDocuments(
  engineUrl: string,
  headers: Record<string, string>,
  space: 'public' | 'private',
): Promise<LiveDocument[]> {
  const res = await fetch(
    `${engineUrl.replace(/\/+$/, '')}/knowledge/documents?knowledge_space_type=${space}`,
    { headers, signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok)
    throw new Error(
      `GET /knowledge/documents ${res.status}: ${await res.text()}`,
    );
  const body: unknown = await res.json();
  const docs =
    typeof body === 'object' && body !== null && 'documents' in body
      ? body.documents
      : undefined;
  assert.ok(
    Array.isArray(docs),
    `no documents array in ${JSON.stringify(body)}`,
  );
  return docs.flatMap((d: unknown) => {
    if (typeof d !== 'object' || d === null) return [];
    const id = 'id' in d ? d.id : undefined;
    const title = 'title' in d ? d.title : undefined;
    const status = 'status' in d ? d.status : undefined;
    return typeof id === 'string' &&
      typeof title === 'string' &&
      typeof status === 'string'
      ? [{ id, title, status }]
      : [];
  });
}

/** The exact arguments of one `add_oracle_document` call, as the prompt states them. */
function addArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args);
}

async function main(): Promise<void> {
  const liveEngineUrl = process.env.MEMORY_ENGINE_URL;
  const liveMcpUrl = process.env.MEMORY_MCP_URL;
  const live = Boolean(liveEngineUrl && liveMcpUrl);
  const mock = live ? undefined : await startMockMcpServer(MOCK_MCP_PORT);
  const engineUrl = mock?.origin ?? liveEngineUrl ?? '';
  const baseExtra = {
    MEMORY_MCP_URL: mock?.mcpUrl ?? liveMcpUrl ?? '',
    MEMORY_ENGINE_URL: engineUrl,
  };
  console.log(
    mock
      ? `mock memory engine at ${mock.origin} (${mock.did})`
      : `LIVE memory engine at ${engineUrl} (mcp ${baseExtra.MEMORY_MCP_URL})`,
  );
  // The first pass creates/finds the oracle account, so the entity DID can be
  // derived from its address; the second pass writes it into `.dev.vars`.
  const provisioned = await provisionDevVars({
    signing: true,
    extra: baseExtra,
  });
  const entityDid = live
    ? (() => {
        const fromEnv = process.env.ORACLE_ENTITY_DID;
        if (!fromEnv || !ENTITY_DID_PATTERN.test(fromEnv))
          throw new Error(
            'live mode needs ORACLE_ENTITY_DID=did:ixo:entity:<32 hex> of a real domain entity',
          );
        return fromEnv;
      })()
    : entityDidFor(ORACLE_DID);
  const model =
    process.env.DEFAULT_MODEL ||
    provisioned.devVars.DEFAULT_MODEL ||
    RUNTIME_DEFAULT_MODEL;
  await provisionDevVars({
    signing: true,
    extra: {
      ...baseExtra,
      ORACLE_ENTITY_DID: entityDid,
      DEFAULT_MODEL: model,
    },
  });
  console.log(`entity DID ${entityDid}, model ${model}`);
  const oracle = await startOracle({
    port: Number(process.env.ORACLE_PORT ?? 8787),
  });
  console.log(`oracle at ${oracle.url}`);
  try {
    // A fresh user per run: the user↔oracle room is keyed by both DIDs.
    const tag = Math.random().toString(36).slice(2, 8);
    // Live: the entity's controller is the harness `tester` user.
    // LIVE writes need domain access on ORACLE_ENTITY_DID: the harness's STATIC
    // tester (its controller and owner), never a fresh account named "tester".
    const staticTester = STATIC_ACCOUNTS.find((a) => a.name === 'tester');
    if (live && !staticTester)
      throw new Error('harness STATIC_ACCOUNTS has no tester');
    const user =
      live && staticTester
        ? staticTester
        : await ensureNamedAccount(`qf-docs-${tag}`);
    const invocation = await mintAuthInvocation(user, ORACLE_DID);
    const delegation = await mintDelegation(user, ORACLE_DID, [
      { can: 'memory/*', with: 'ixo:memory' },
    ]);
    const client = new ChatClient(oracle.url, { invocation, delegation });
    const docId = `board-res-${tag}`;
    const marker = `kingfisher-${tag}`;
    let session: MatrixSession | undefined;
    const matrixSession = (): MatrixSession => {
      if (!session) throw new Error('the Matrix session is not set up yet');
      return session;
    };

    let roomId = '';
    const liveHeaders = (): Record<string, string> => ({
      'x-service-api-key': process.env.MEMORY_SERVICE_API_KEY ?? '',
      'x-user-did': user.did,
      'x-oracle-did': ORACLE_DID,
      'x-room-id': roomId,
      'x-oracle-entity-did': entityDid,
    });
    const liveList = () => liveDocuments(engineUrl, liveHeaders(), 'public');

    await step('the user↔oracle room exists and the bot is in it', async () => {
      session = await matrixLogin(user.matrixUserId, user.matrixPassword);
      roomId = await ensureUserOracleRoom({
        session,
        userDid: user.did,
        // The room alias is built from the entity DID the oracle runs with.
        oracleDid: entityDid,
        botUserId: BOT_USER_ID,
        roomName: 'qf-docs-user ↔ QiForge Workers',
      });
      await waitForMatrixGateway(oracle.url);
    });

    const turn = (
      sessionId: string,
      message: string,
      body?: Record<string, unknown>,
    ) =>
      client.stream(sessionId, message, {
        signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
        ...(body ? { body } : {}),
      });
    /** Did a session's transcript call the upstream add_oracle_knowledge? */
    const usedAddOracleKnowledge = async (
      sessionId: string,
    ): Promise<boolean> => {
      if (mock)
        return mock.state.toolCalls.some(
          (c) => c.tool === 'add_oracle_knowledge',
        );
      // Compare tool NAMES only: a tool's output (load_capability lists the
      // memory tools) may mention add_oracle_knowledge without calling it.
      const { messages } = await client.listMessages(sessionId);
      return messages.some((m) =>
        (m.toolCalls ?? []).some(
          (c) =>
            typeof c === 'object' &&
            c !== null &&
            'name' in c &&
            typeof c.name === 'string' &&
            c.name.endsWith('add_oracle_knowledge'),
        ),
      );
    };

    await step(
      'the three document tools are offered to the model',
      async () => {
        const probe = await client.createSession();
        const r = await turn(probe, 'Reply with exactly: READY');
        assert.equal(r.status, 200, `status ${r.status}: ${r.text}`);
        const line = oracle
          .logs()
          .split('\n')
          .filter((l) => l.includes('tool surface:'))
          .pop();
        assert.ok(
          oracle.url !== '' && (line !== undefined || process.env.ORACLE_URL),
          'the oracle logged no "tool surface" line',
        );
        if (line !== undefined) {
          for (const name of [
            'add_oracle_document',
            'list_oracle_documents',
            'delete_oracle_document',
          ]) {
            assert.ok(line.includes(name), `${name} missing from: ${line}`);
          }
        }
      },
    );

    await step(
      'a grouped document is written with its id, title, text and engine headers',
      async () => {
        const filename = `resolution-${tag}.txt`;
        const file = await uploadText(
          matrixSession(),
          filename,
          `Board resolution 2026-10. The board resolves to adopt the ${marker} travel policy.`,
        );
        const groupedSession = await client.createSession();
        const r = await turn(
          groupedSession,
          `I attached a board resolution and I confirm it may be visible to every user of the oracle. ` +
            `Call add_oracle_document exactly once with exactly these arguments and call no other tool: ` +
            `${addArgs({
              source: { kind: 'attachment', ref: file.mxcUri },
              title: 'Board resolution',
              knowledge_space_type: 'public',
              group_as_document: true,
              document_id: docId,
              confirmed_insertion_from_user: true,
            })} ` +
            `Then reply with exactly: STORED`,
          attachmentBody(file.mxcUri, filename, file.size),
        );
        assert.equal(r.status, 200, `status ${r.status}: ${r.text}`);
        assert.equal(
          await usedAddOracleKnowledge(groupedSession),
          false,
          'the model used add_oracle_knowledge for a file',
        );
        if (!mock) {
          const doc = await pollUntil(
            `document ${docId} to be ready`,
            READY_TIMEOUT_MS,
            async () => {
              const found = (await liveList()).find((d) => d.id === docId);
              if (found?.status === 'partial')
                throw new Error(`document ${docId} ended partial`);
              return found?.status === 'ready' ? found : undefined;
            },
          ).catch(async (err: unknown) => {
            throw new Error(
              `${err instanceof Error ? err.message : String(err)}; reply: "${r.text}"; tool outputs: ${await toolOutputs(client, oracle.url, groupedSession)}`,
            );
          });
          assert.equal(doc.title, 'Board resolution');
          return;
        }
        const post = mock.state.documentRequests.find(
          (q) => q.method === 'POST',
        );
        assert.ok(
          post,
          `no POST /knowledge/documents reached the engine; reply: "${r.text}"; tool outputs: ${await toolOutputs(client, oracle.url, groupedSession)}`,
        );
        assert.equal(post.xAuthType, 'ucan');
        assert.ok(
          post.authorization?.startsWith('Bearer ') &&
            post.authorization.length > 100,
          'the request carried no Bearer UCAN invocation',
        );
        assert.equal(post.xOracleEntityDid, entityDid);
        assert.ok(post.xRoomId, 'the request carried no x-room-id');
        const doc = mock.state.documents.find((d) => d.id === docId);
        assert.ok(
          doc,
          `no grouped document "${docId}"; engine saw ${JSON.stringify(post.body).slice(0, 400)}`,
        );
        assert.equal(doc.title, 'Board resolution');
        assert.equal(doc.space, 'public');
        assert.ok(
          doc.chunks.some((c) => c.content.includes(marker)),
          `the file's text did not reach the engine: ${JSON.stringify(doc.chunks)}`,
        );
        assert.equal(mock.state.looseChunks.length, 0);
      },
    );

    await step('list_oracle_documents reads the document back', async () => {
      const before = mock?.state.documentRequests.length ?? 0;
      const r = await turn(
        await client.createSession(),
        `Call list_oracle_documents exactly once with exactly these arguments and call no other tool: ${JSON.stringify({ knowledge_space_type: 'public' })} ` +
          'Then reply with the ids of the documents it returned.',
      );
      assert.equal(r.status, 200, `status ${r.status}: ${r.text}`);
      if (mock) {
        const listed = mock.state.documentRequests
          .slice(before)
          .filter(
            (q) =>
              q.method === 'GET' &&
              q.pathname === '/knowledge/documents' &&
              q.search.includes('knowledge_space_type=public'),
          );
        assert.ok(
          listed.length > 0,
          'no GET /knowledge/documents?knowledge_space_type=public reached the engine (the access pre-check reads the private space)',
        );
      }
      assert.ok(r.text.includes(docId), `expected ${docId} in "${r.text}"`);
    });

    await step(
      'a file of unrelated facts is written as loose chunks with no document',
      async () => {
        const filename = `facts-${tag}.txt`;
        const file = await uploadText(
          matrixSession(),
          filename,
          `The office is on Harbour Street. Refunds are paid within 14 days. The mascot is a ${marker}.`,
        );
        const documentsBefore = mock
          ? mock.state.documents.length
          : (await liveList()).length;
        const looseSession = await client.createSession();
        const r = await turn(
          looseSession,
          `I attached a file where I dumped a few unrelated company facts so I could upload them in one go. I confirm it may be visible to every user of the oracle. ` +
            `Call add_oracle_document exactly once with exactly these arguments and call no other tool: ` +
            `${addArgs({
              source: { kind: 'attachment', ref: file.mxcUri },
              title: 'Company facts',
              knowledge_space_type: 'public',
              group_as_document: false,
              confirmed_insertion_from_user: true,
            })} ` +
            `Then reply with exactly: STORED`,
          attachmentBody(file.mxcUri, filename, file.size),
        );
        assert.equal(r.status, 200, `status ${r.status}: ${r.text}`);
        assert.equal(
          await usedAddOracleKnowledge(looseSession),
          false,
          'the model used add_oracle_knowledge for a file',
        );
        if (mock) {
          assert.ok(
            mock.state.looseChunks.length > 0,
            `no loose chunks reached the engine; reply: "${r.text}"; transcript: ${await toolOutputs(client, oracle.url, looseSession)}`,
          );
          assert.ok(
            mock.state.looseChunks.some((c) => c.content.includes(marker)),
            'the loose chunks do not hold the file text',
          );
        } else {
          const outputs = await toolOutputs(client, oracle.url, looseSession);
          assert.ok(
            outputs.includes('add_oracle_document') &&
              outputs.includes('queued'),
            `the loose write was not queued: ${outputs}`,
          );
        }
        // A loose write never creates a listable document.
        assert.equal(
          mock ? mock.state.documents.length : (await liveList()).length,
          documentsBefore,
          'a loose write created a grouped document',
        );
      },
    );

    if (!mock) {
      await step(
        'a fresh session answers a question about the document through search_memory_engine',
        async () => {
          const searchSession = await client.createSession();
          const r = await pollUntil(
            'the document fact to be found by search',
            READY_TIMEOUT_MS,
            async () => {
              const answer = await turn(
                searchSession,
                'Use search_memory_engine to find which travel policy the board adopted in the 2026-10 board resolution. ' +
                  'Reply with the exact policy name from the knowledge you found.',
              );
              return answer.status === 200 && answer.text.includes(marker)
                ? answer
                : undefined;
            },
          );
          assert.ok(r.text.includes(marker));
        },
      );

      await step(
        'a three-page PDF is stored as one document and a fact from its last page is recalled',
        async () => {
          const pdfId = `pdf-res-${tag}`;
          const pdfMarker = `heron-${tag}`;
          const filename = `board-minutes-${tag}.pdf`;
          const pdf = makePdf([
            [
              'Minutes of the board meeting, October 2026.',
              'Present: the chair, the treasurer and two directors.',
            ],
            [
              'Item 1: the 2027 budget was reviewed and approved.',
              'Item 2: the audit report was noted.',
            ],
            [
              `Item 3: the board resolves that the new community fund is named ${pdfMarker}.`,
              'Signed by the chair.',
            ],
          ]);
          const file = await uploadBytes(
            matrixSession(),
            filename,
            pdf,
            'application/pdf',
          );
          const pdfSession = await client.createSession();
          const r = await turn(
            pdfSession,
            `I attached the board minutes as a PDF and I confirm they may be visible to every user of the oracle. ` +
              `Call add_oracle_document exactly once with exactly these arguments and call no other tool: ` +
              `${addArgs({
                source: { kind: 'attachment', ref: file.mxcUri },
                title: 'Board minutes October 2026',
                knowledge_space_type: 'public',
                group_as_document: true,
                document_id: pdfId,
                confirmed_insertion_from_user: true,
              })} ` +
              `Then reply with exactly: STORED`,
            attachmentBody(file.mxcUri, filename, file.size, 'application/pdf'),
          );
          assert.equal(r.status, 200, `status ${r.status}: ${r.text}`);
          await pollUntil(
            `document ${pdfId} to be ready`,
            READY_TIMEOUT_MS,
            async () => {
              const found = (await liveList()).find((d) => d.id === pdfId);
              if (found?.status === 'partial')
                throw new Error(`document ${pdfId} ended partial`);
              return found?.status === 'ready' ? found : undefined;
            },
          ).catch(async (err: unknown) => {
            throw new Error(
              `${err instanceof Error ? err.message : String(err)}; reply: "${r.text}"; tool outputs: ${await toolOutputs(client, oracle.url, pdfSession)}`,
            );
          });
          const outputs = await toolOutputs(client, oracle.url, pdfSession);
          assert.ok(
            outputs.includes('pdf'),
            `the PDF was not read by the local text layer (method pdf): ${outputs}`,
          );
          const askSession = await client.createSession();
          const answer = await pollUntil(
            'the PDF fact to be found by search',
            READY_TIMEOUT_MS,
            async () => {
              const a = await turn(
                askSession,
                'Use search_memory_engine to find what name the board gave the new community fund in the October 2026 board minutes. ' +
                  'Reply with the exact name from the knowledge you found.',
              );
              return a.status === 200 && a.text.includes(pdfMarker)
                ? a
                : undefined;
            },
          );
          assert.ok(answer.text.includes(pdfMarker));
          // Leave no test document behind in the engine.
          const del = await fetch(
            `${engineUrl.replace(/\/+$/, '')}/knowledge/documents/${pdfId}?knowledge_space_type=public`,
            {
              method: 'DELETE',
              headers: liveHeaders(),
              signal: AbortSignal.timeout(30_000),
            },
          );
          assert.equal(
            del.status,
            202,
            `cleanup DELETE ${del.status}: ${await del.text()}`,
          );
        },
      );
    }

    await step(
      'delete_oracle_document removes the grouped document (the engine finishes in the background)',
      async () => {
        const deleteSession = await client.createSession();
        const r = await turn(
          deleteSession,
          `I confirm the deletion. Call delete_oracle_document exactly once with exactly these arguments and call no other tool: ` +
            `${JSON.stringify({
              document_id: docId,
              knowledge_space_type: 'public',
              confirmed_deletion_from_user: true,
            })} ` +
            `Then reply with exactly: DELETED`,
        );
        assert.equal(r.status, 200, `status ${r.status}: ${r.text}`);
        if (mock) {
          assert.ok(
            mock.state.documentRequests.some((q) => q.method === 'DELETE'),
            `no DELETE reached the engine; reply: "${r.text}"`,
          );
        }
        await pollUntil(
          `document ${docId} to disappear`,
          mock ? 10_000 : READY_TIMEOUT_MS,
          async () => {
            const present = mock
              ? mock.state.documents.some((d) => d.id === docId)
              : (await liveList()).some((d) => d.id === docId);
            return present ? undefined : true;
          },
        );
      },
    );
  } finally {
    await oracle.stop();
    await mock?.stop();
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      const logs = oracle.logs();
      if (logs)
        console.error(`\n--- oracle logs (tail) ---\n${logs.slice(-6000)}`);
    }
    console.log('\n=== E2E (oracle documents) summary ===');
    for (const r of results)
      console.log(
        `${r.ok ? '✔' : '✘'} ${r.name} (${r.ms} ms)${r.detail ? `\n    ${r.detail}` : ''}`,
      );
    console.log(`${results.length - failed.length}/${results.length} passed`);
    if (failed.length) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
