/**
 * Session lifecycle integration test.
 *
 * Walks one session through the full `POST /sessions` → `GET /sessions` →
 * `POST /messages/:sessionId` → `GET /messages/:sessionId` →
 * `DELETE /sessions/:sessionId` → `GET /sessions` path against a real
 * booted oracle. Guards the wire contract between `SessionsController`,
 * `SessionsService`, and the Matrix-backed `SessionManagerService`:
 *
 *   - createSession returns a sessionId we can drive subsequent calls with.
 *   - listSessions includes the freshly-created session.
 *   - send round-trips a human + AI message pair through the chat pipeline.
 *   - listMessages echoes both messages back.
 *   - deleteSession succeeds and the session disappears from listSessions.
 *
 * Tests are intentionally ordered — `sessionId` is created in test 1 and
 * reused through test 5. One oracle, one ChatClient shared across the
 * whole describe (Tier B convention). Missing env throws at file load.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  allCaps,
  ChatClient,
  createIntegrationOracle,
  mintUserDelegation,
  waitForMatrixLoaded,
  type IntegrationOracle,
} from '../../src/testing/integration/index.js';

const REQUIRED_ENV = [
  'TEST_USER_MNEMONIC',
  'TEST_USER_DID',
  'ORACLE_DID',
  'ORACLE_ENTITY_DID',
  'MATRIX_BASE_URL',
  'OPEN_ROUTER_API_KEY',
] as const;
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(
    `session-lifecycle.int.test.ts requires the following env vars (see packages/oracle-runtime/.env.integration): ${missing.join(', ')}`,
  );
}

interface SessionListEntry {
  sessionId: string;
}

interface ListSessionsBody {
  sessions: SessionListEntry[];
  total?: number;
}

function isListSessionsBody(value: unknown): value is ListSessionsBody {
  if (typeof value !== 'object' || value === null) return false;
  const maybe = value as { sessions?: unknown };
  return (
    Array.isArray(maybe.sessions) &&
    maybe.sessions.every(
      (s) =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as { sessionId?: unknown }).sessionId === 'string',
    )
  );
}

interface MessageEntry {
  type?: string;
  content?: string;
}

interface ListMessagesBody {
  messages: MessageEntry[];
}

function isListMessagesBody(value: unknown): value is ListMessagesBody {
  if (typeof value !== 'object' || value === null) return false;
  const maybe = value as { messages?: unknown };
  return Array.isArray(maybe.messages);
}

describe('Session lifecycle (integration)', () => {
  let oracle: IntegrationOracle;
  let client: ChatClient;
  let sessionId: string;

  beforeAll(async () => {
    oracle = await createIntegrationOracle({
      plugins: [],
      bundledPlugins: [],
    });
    await waitForMatrixLoaded(oracle);

    const delegation = await mintUserDelegation({
      userMnemonic: process.env.TEST_USER_MNEMONIC!,
      userDid: process.env.TEST_USER_DID!,
      oracleDid: process.env.ORACLE_DID!,
      capabilities: allCaps,
    });
    client = new ChatClient(oracle.baseUrl, { delegation });
  }, 120_000);

  afterAll(async () => {
    if (oracle) await oracle.close();
  });

  test('createSession returns a sessionId we can drive subsequent calls with', async () => {
    sessionId = await client.createSession();
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);
  }, 120_000);

  test('listSessions returns the freshly-created session', async () => {
    const res = await client.fetch('/sessions', { method: 'GET' });
    expect(res.ok).toBe(true);
    const body: unknown = await res.json();
    expect(isListSessionsBody(body)).toBe(true);
    if (!isListSessionsBody(body)) return;
    const match = body.sessions.find((s) => s.sessionId === sessionId);
    expect(match).toBeTruthy();
  }, 60_000);

  test('chatClient.send returns 200 with a non-empty assistant response', async () => {
    const res = await client.send(sessionId, 'hello');
    expect(res.status).toBe(200);
    expect(res.body.message).toBeTruthy();
    expect((res.body.message.content || '').length).toBeGreaterThan(0);
  }, 120_000);

  test('listMessages returns at least the human + AI message pair', async () => {
    const res = await client.list(sessionId);
    expect(res.status).toBe(200);
    expect(isListMessagesBody(res.body)).toBe(true);
    if (!isListMessagesBody(res.body)) return;
    expect(res.body.messages.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  test('deleteSession returns success', async () => {
    const res = await client.fetch(
      `/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    );
    expect(res.ok).toBe(true);
  }, 60_000);

  test('listSessions no longer returns the deleted session', async () => {
    const res = await client.fetch('/sessions', { method: 'GET' });
    expect(res.ok).toBe(true);
    const body: unknown = await res.json();
    expect(isListSessionsBody(body)).toBe(true);
    if (!isListSessionsBody(body)) return;
    const match = body.sessions.find((s) => s.sessionId === sessionId);
    expect(match).toBeUndefined();
  }, 60_000);
});
