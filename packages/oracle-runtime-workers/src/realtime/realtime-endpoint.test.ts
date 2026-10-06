/**
 * The socket.io endpoint end to end inside workerd: a real WebSocket pair
 * through `RealtimeTestDO` (`test/wrangler.test.jsonc`), the wire protocol
 * as `socket.io-client` speaks it, auth in the CONNECT packet, fan-out
 * through the router, and browser-tool / AG-UI round trips.
 */
import { env } from 'cloudflare:test';
import {
  FRONTEND_OUTCOME_UNKNOWN,
  FRONTEND_OUTCOME_UNKNOWN_MESSAGE,
} from '@ixo/common/ai/frontend-bridge';
import { describe, expect, it } from 'vitest';
import { HANDSHAKE_DEADLINE_MS, MAX_PAYLOAD_BYTES } from './realtime-endpoint';
import {
  TEST_BARE_DELEGATION,
  TEST_BROKEN_SESSION,
  TEST_GOOD_TOKEN,
  TEST_MISSING_SESSION,
  TEST_SLOW_AUTH_MS,
  TEST_SLOW_TOKEN,
  TEST_USER_DID,
  type RealtimeTestDO,
} from './test-do';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      REALTIME_TEST: DurableObjectNamespace<RealtimeTestDO>;
    }
  }
}

function stub(name: string): DurableObjectStub<RealtimeTestDO> {
  return env.REALTIME_TEST.get(env.REALTIME_TEST.idFromName(name));
}

interface Client {
  ws: WebSocket;
  frames: string[];
  /** First frame (seen or future) matching `pick`. */
  next: (pick: (f: string) => boolean, label?: string) => Promise<string>;
  closed: Promise<{ code: number; reason: string }>;
}

async function open(
  s: DurableObjectStub<RealtimeTestDO>,
  opts: {
    sessionId?: string;
    routedUserDid?: string;
    query?: string;
    upgrade?: boolean;
  } = {},
): Promise<{ res: Response; client: Client | null }> {
  const sessionId = opts.sessionId ?? 's1';
  const query =
    opts.query ??
    `EIO=4&transport=websocket&sessionId=${encodeURIComponent(sessionId)}&userDid=x`;
  const res = await s.fetch(`https://do/socket.io/?${query}`, {
    headers: {
      ...(opts.upgrade === false ? {} : { upgrade: 'websocket' }),
      'x-routed-user-did': opts.routedUserDid ?? TEST_USER_DID,
    },
  });
  if (res.status !== 101 || !res.webSocket) return { res, client: null };
  const ws = res.webSocket;
  const frames: string[] = [];
  const waiters: Array<{
    pick: (f: string) => boolean;
    resolve: (f: string) => void;
  }> = [];
  ws.accept();
  ws.addEventListener('message', (ev) => {
    const frame = String(ev.data);
    frames.push(frame);
    for (const w of [...waiters]) {
      if (w.pick(frame)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(frame);
      }
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener('close', (ev) =>
      resolve({ code: ev.code, reason: ev.reason }),
    );
  });
  const next = (
    pick: (f: string) => boolean,
    label = 'frame',
  ): Promise<string> => {
    const seen = frames.find(pick);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`no ${label} within 5s; frames: ${frames.join(' | ')}`),
          ),
        5000,
      );
      waiters.push({
        pick,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  };
  return { res, client: { ws, frames, next, closed } };
}

const event = (frame: string): { name: string; payload: unknown } => {
  const parsed = JSON.parse(frame.slice(frame.indexOf('['))) as unknown[];
  return { name: String(parsed[0]), payload: parsed[1] };
};
const isEvent = (name: string) => (f: string) =>
  f.startsWith('42') && event(f).name === name;
/** A runtime event on Node's wire: socket event `event` whose envelope names `eventName`. */
const isEnvelope = (eventName: string) => (f: string) =>
  isEvent('event')(f) &&
  (event(f).payload as { eventName?: string }).eventName === eventName;
/** The client SDK's `isWebSocketEvent` guard (use-websocket-events.tsx), verbatim. */
const sdkAcceptsEnvelope = (ev: unknown): boolean =>
  typeof ev === 'object' &&
  ev !== null &&
  'eventName' in ev &&
  'payload' in ev &&
  typeof ev.payload === 'object' &&
  ev.payload !== null &&
  'sessionId' in ev.payload &&
  'requestId' in ev.payload;

/** The invocation id a frontend call frame carries (what the client echoes). */
const invocationOf = (payload: unknown): string => {
  const id = (payload as { toolCallId?: unknown }).toolCallId;
  if (typeof id !== 'string') throw new Error('call frame without toolCallId');
  return id;
};
/** Send a result event the way the client SDK does. */
const answer = (
  c: Client,
  name: 'tool_result' | 'action_call_result',
  payload: Record<string, unknown>,
): void => c.ws.send(`42${JSON.stringify([name, payload])}`);
/** Messages on one socket are handled in order: a pong means the earlier frames were. */
async function roundTrip(c: Client): Promise<void> {
  const pongs = c.frames.filter(isEvent('pong')).length;
  c.ws.send('42["ping"]');
  await c.next(
    () => c.frames.filter(isEvent('pong')).length > pongs,
    'pong after round trip',
  );
}

async function connect(
  s: DurableObjectStub<RealtimeTestDO>,
  opts: Parameters<typeof open>[1] = {},
): Promise<Client> {
  const { client } = await open(s, opts);
  if (!client) throw new Error('upgrade refused');
  await client.next((f) => f.startsWith('0{'), 'OPEN');
  client.ws.send(`40${JSON.stringify({ invocation: TEST_GOOD_TOKEN })}`);
  await client.next((f) => f.startsWith('40'), 'CONNECT ack');
  await client.next(isEvent('connected'), 'connected');
  return client;
}

describe('RealtimeEndpoint over real WebSockets', () => {
  it('handshakes like socket.io: OPEN → CONNECT(auth) → ack + connected; ping/status/list-events; acks', async () => {
    const s = stub('handshake');
    const { client } = await open(s);
    expect(client).not.toBeNull();
    const c = client!;
    const openFrame = await c.next((f) => f.startsWith('0{'), 'OPEN');
    const hs = JSON.parse(openFrame.slice(1)) as {
      sid: string;
      upgrades: string[];
      pingInterval: number;
      pingTimeout: number;
      maxPayload: number;
    };
    expect(hs.sid).toMatch(/[0-9a-f-]{36}/);
    expect(hs.upgrades).toEqual([]);
    expect(hs.pingInterval).toBe(180_000);
    expect(hs.pingTimeout).toBe(60_000);

    c.ws.send(`40${JSON.stringify({ invocation: TEST_GOOD_TOKEN })}`);
    const ack = await c.next((f) => f.startsWith('40'), 'CONNECT ack');
    expect(JSON.parse(ack.slice(2))).toEqual({ sid: hs.sid });
    const connected = event(await c.next(isEvent('connected'), 'connected'));
    expect(connected.payload).toMatchObject({
      message: 'Connected successfully',
      sessionId: 's1',
    });

    c.ws.send('42["ping"]');
    expect(event(await c.next(isEvent('pong'))).payload).toMatchObject({
      sessionId: 's1',
    });
    c.ws.send('42["status"]');
    expect(event(await c.next(isEvent('status'))).payload).toMatchObject({
      connected: true,
      sessionId: 's1',
      activeSessions: 1,
      totalConnections: 1,
    });
    // An event carrying an ack id gets the ack back, then the reply.
    c.ws.send('427["list-events"]');
    expect(await c.next((f) => f === '437[]', 'ACK 7')).toBe('437[]');
    const listed = event(await c.next(isEvent('available-events')));
    expect(
      (listed.payload as { serverEvents: string[] }).serverEvents,
    ).toContain('browser_tool_call');
    // engine.io ping from the client side is answered with a pong.
    c.ws.send('2');
    await c.next((f) => f === '3', 'engine pong');

    expect(await s.status()).toMatchObject({
      sockets: 1,
      authenticated: 1,
      sessions: 1,
    });
    expect(await s.hasClient('s1')).toBe(true);
    expect(await s.hasClient('other')).toBe(false);

    c.ws.send('41');
    const closed = await c.closed;
    expect(closed.code).toBe(1000);
    expect((await s.status()).sockets).toBe(0);
  });

  it('refuses a bad token, a token for another routed user, an unknown session, and events before CONNECT', async () => {
    const s = stub('refusals');

    const bad = (await open(s)).client!;
    await bad.next((f) => f.startsWith('0{'));
    bad.ws.send('40{"invocation":"wrong"}');
    const err = await bad.next((f) => f.startsWith('44'), 'CONNECT_ERROR');
    expect(JSON.parse(err.slice(2))).toEqual({
      message: 'Unauthorized: Invalid UCAN invocation: nope',
    });
    expect((await bad.closed).code).toBe(4401);

    const foreign = (await open(s, { routedUserDid: 'did:ixo:someoneelse' }))
      .client!;
    await foreign.next((f) => f.startsWith('0{'));
    foreign.ws.send(`40{"invocation":"${TEST_GOOD_TOKEN}"}`);
    expect(await foreign.next((f) => f.startsWith('44'))).toContain(
      'does not belong',
    );
    expect((await foreign.closed).code).toBe(4401);

    const missing = (await open(s, { sessionId: TEST_MISSING_SESSION }))
      .client!;
    await missing.next((f) => f.startsWith('0{'));
    missing.ws.send(`40{"invocation":"${TEST_GOOD_TOKEN}"}`);
    expect(await missing.next((f) => f.startsWith('44'))).toContain(
      `Session ${TEST_MISSING_SESSION} not found`,
    );

    const noAuth = (await open(s)).client!;
    await noAuth.next((f) => f.startsWith('0{'));
    noAuth.ws.send('40');
    expect(await noAuth.next((f) => f.startsWith('44'))).toContain(
      'missing UCAN auth',
    );

    const early = (await open(s)).client!;
    await early.next((f) => f.startsWith('0{'));
    early.ws.send('42["ping"]');
    expect(await early.next((f) => f.startsWith('44'))).toContain(
      'Unauthorized',
    );
    expect((await early.closed).code).toBe(4401);

    expect((await s.status()).sockets).toBe(0);
  });

  it('logs a CONNECT the bare-delegation fallback authenticated, as the shell does for HTTP; an invocation logs nothing', async () => {
    const s = stub('bare-delegation-log');
    const withInvocation = await connect(s);
    expect(
      (await s.loggedWarnings()).filter((w) => w.includes('bare delegation')),
    ).toEqual([]);

    const bare = (await open(s, { sessionId: 's2' })).client!;
    await bare.next((f) => f.startsWith('0{'), 'OPEN');
    bare.ws.send(
      `40${JSON.stringify({ ucanDelegation: TEST_BARE_DELEGATION })}`,
    );
    await bare.next(isEvent('connected'), 'connected');
    expect(
      (await s.loggedWarnings()).filter((w) => w.includes('bare delegation')),
    ).toEqual([
      `[auth] socket CONNECT s2: ${TEST_USER_DID} authenticated with a bare delegation (UCAN_ALLOW_BARE_DELEGATION_AUTH); the client must send a UCAN invocation before the fallback is turned off`,
    ]);
    withInvocation.ws.close();
    bare.ws.close();
  });

  it('rejects non-websocket handshakes with the engine.io error shape', async () => {
    const s = stub('bad-handshake');
    const polling = await open(s, {
      query: 'EIO=4&transport=polling&sessionId=s1',
    });
    expect(polling.res.status).toBe(400);
    expect(await polling.res.json()).toMatchObject({ code: 3 });
    const noUpgrade = await open(s, { upgrade: false });
    expect(noUpgrade.res.status).toBe(426);
    const oldProto = await open(s, {
      query: 'EIO=3&transport=websocket&sessionId=s1',
    });
    expect(oldProto.res.status).toBe(400);
    const noSession = await open(s, { query: 'EIO=4&transport=websocket' });
    expect(noSession.res.status).toBe(400);
    expect(await noSession.res.text()).toContain('sessionId');
  });

  it('fans runtime events out to the session that owns them only, in the SDK envelope', async () => {
    const s = stub('fanout');
    const a = await connect(s, { sessionId: 'sa' });
    const b = await connect(s, { sessionId: 'sb' });
    await s.emitForSession('sa', 'tool_call', {
      requestId: 'r1',
      toolName: 'x',
      status: 'done',
    });
    await s.emitForSession('sb', 'render_component', { component: 'card' });
    // Node's wire, which the client SDK validates before it dispatches: the
    // socket event is `event` and carries `{ eventName, payload }` with the
    // session and request ids inside the payload.
    const toA = event(await a.next(isEnvelope('tool_call')));
    expect(toA).toEqual({
      name: 'event',
      payload: {
        eventName: 'tool_call',
        payload: {
          requestId: 'r1',
          toolName: 'x',
          status: 'done',
          sessionId: 'sa',
        },
      },
    });
    expect(sdkAcceptsEnvelope(toA.payload)).toBe(true);
    const toB = event(await b.next(isEnvelope('render_component')));
    expect(toB.payload).toEqual({
      eventName: 'render_component',
      payload: { component: 'card', sessionId: 'sb' },
    });
    // Never as a bare named frame — the SDK's named listener would read
    // `payload.sessionId` off the raw payload and throw.
    expect(a.frames.some(isEvent('tool_call'))).toBe(false);
    expect(b.frames.some(isEvent('render_component'))).toBe(false);
    expect(a.frames.some(isEnvelope('render_component'))).toBe(false);
    expect(b.frames.some(isEnvelope('tool_call'))).toBe(false);
    expect(await s.status()).toMatchObject({
      sockets: 2,
      authenticated: 2,
      sessions: 2,
    });
    a.ws.close(1000, 'bye');
    b.ws.close(1000, 'bye');
  });

  it('round-trips a browser tool call and an AG-UI action through the socket', async () => {
    const s = stub('roundtrip');
    const c = await connect(s, { sessionId: 'rt' });

    const browser = s.callBrowserTool({
      sessionId: 'rt',
      toolCallId: 'tc-1',
      toolName: 'open_url',
      args: { url: 'https://example.com' },
      timeoutMs: 5000,
    });
    const call = event(await c.next(isEvent('browser_tool_call')));
    const tc1 = invocationOf(call.payload);
    // The caller's id stays readable; the bridge makes the invocation unique.
    expect(tc1).toMatch(/^tc-1:[0-9a-f-]{36}$/);
    expect(call.payload).toEqual({
      sessionId: 'rt',
      requestId: 'tc-1',
      toolCallId: tc1,
      toolName: 'open_url',
      args: { url: 'https://example.com' },
    });
    answer(c, 'tool_result', { toolCallId: tc1, result: { opened: true } });
    expect(await browser).toEqual({ ok: true, value: { opened: true } });

    const failing = s.callBrowserTool({
      sessionId: 'rt',
      toolCallId: 'tc-2',
      toolName: 'open_url',
      args: {},
      timeoutMs: 5000,
    });
    const tc2 = invocationOf(
      event(await c.next((f) => f.includes('"tc-2:'))).payload,
    );
    answer(c, 'tool_result', {
      toolCallId: tc2,
      result: null,
      error: 'Tool open_url not found',
    });
    expect(await failing).toEqual({
      ok: false,
      error: 'Tool open_url not found',
    });

    const action = s.callAgAction({
      sessionId: 'rt',
      toolCallId: 'ag_1',
      toolName: 'render_table',
      args: { rows: 2 },
      timeoutMs: 5000,
    });
    const actionCall = event(await c.next(isEvent('action_call')));
    const ag1 = invocationOf(actionCall.payload);
    expect(ag1).toMatch(/^ag_1:/);
    expect(actionCall.payload).toMatchObject({
      toolCallId: ag1,
      toolName: 'render_table',
      args: { rows: 2 },
      status: 'isRunning',
    });
    answer(c, 'action_call_result', {
      toolCallId: ag1,
      sessionId: 'rt',
      result: { success: true, id: 't1' },
    });
    expect(await action).toEqual({
      ok: true,
      value: { success: true, id: 't1' },
    });

    const refused = s.callAgAction({
      sessionId: 'rt',
      toolCallId: 'ag_2',
      toolName: 'render_table',
      args: {},
      timeoutMs: 5000,
    });
    const ag2 = invocationOf(
      event(await c.next((f) => f.includes('"ag_2:'))).payload,
    );
    answer(c, 'action_call_result', {
      toolCallId: ag2,
      result: { success: false, error: 'render failed' },
    });
    expect(await refused).toEqual({ ok: false, error: 'render failed' });

    // A client that cannot tell whether its write landed says so; the
    // runtime hands that to the model instead of turning it into a failure.
    const uncertain = s.callAgAction({
      sessionId: 'rt',
      toolCallId: 'ag_3',
      toolName: 'render_table',
      args: {},
      timeoutMs: 5000,
    });
    const ag3 = invocationOf(
      event(await c.next((f) => f.includes('"ag_3:'))).payload,
    );
    answer(c, 'action_call_result', {
      toolCallId: ag3,
      result: { success: false, outcome: 'unknown' },
    });
    expect(await uncertain).toEqual({
      ok: true,
      value: { success: false, outcome: 'unknown' },
    });

    expect((await s.status()).pendingCalls).toEqual([]);
    c.ws.close(1000, 'bye');
  });

  it('reports an unknown outcome, not a failure, when the answer misses its deadline', async () => {
    const s = stub('deadline');
    const c = await connect(s, { sessionId: 'dl' });
    const slow = s.callBrowserTool({
      sessionId: 'dl',
      toolCallId: 'tc-slow',
      toolName: 'mutate_topic',
      args: { field: 'title', value: 'PRIVATE-ARG' },
      timeoutMs: 50,
    });
    const id = invocationOf(
      event(await c.next(isEvent('browser_tool_call'))).payload,
    );
    expect(await slow).toEqual({
      ok: true,
      value: {
        success: false,
        code: FRONTEND_OUTCOME_UNKNOWN,
        outcome: 'unknown',
        invocationId: id,
        message: FRONTEND_OUTCOME_UNKNOWN_MESSAGE,
      },
    });
    // A late answer to a call already reported unknown settles nothing.
    answer(c, 'tool_result', { toolCallId: id, result: 'PRIVATE-RESULT' });
    await roundTrip(c);
    const status = await s.status();
    expect(status.pendingCalls).toEqual([]);
    expect(status.completedCalls).toBe(1);
    const warnings = await s.loggedWarnings();
    expect(warnings.some((w) => w.includes(id) && w.includes('already'))).toBe(
      true,
    );
    expect(warnings.join('\n')).not.toMatch(/PRIVATE-(ARG|RESULT)/);
    c.ws.close(1000, 'bye');
  });

  it("does not let a socket of another session answer this session's call, whatever sessionId it claims", async () => {
    const s = stub('cross-session');
    const own = await connect(s, { sessionId: 'mine' });
    const other = await connect(s, { sessionId: 'other' });

    const browser = s.callBrowserTool({
      sessionId: 'mine',
      toolCallId: 'tc-guess',
      toolName: 'open_url',
      args: {},
      timeoutMs: 5000,
    });
    const id = invocationOf(
      event(await own.next(isEvent('browser_tool_call'))).payload,
    );
    answer(other, 'tool_result', {
      toolCallId: id,
      sessionId: 'mine',
      result: { forged: true },
    });
    await roundTrip(other);
    expect((await s.status()).pendingCalls.map((c) => c.toolCallId)).toEqual([
      id,
    ]);

    answer(own, 'tool_result', { toolCallId: id, result: { opened: true } });
    expect(await browser).toEqual({ ok: true, value: { opened: true } });
    own.ws.close(1000, 'bye');
    other.ws.close(1000, 'bye');
  });
});

describe('frontend bridge: one invocation, one socket, one result', () => {
  it('fails closed when the session ownership lookup fails', async () => {
    const s = stub('ownership-broken');
    const c = (await open(s, { sessionId: TEST_BROKEN_SESSION })).client!;
    await c.next((f) => f.startsWith('0{'), 'OPEN');
    c.ws.send(`40${JSON.stringify({ invocation: TEST_GOOD_TOKEN })}`);
    expect(await c.next((f) => f.startsWith('44'), 'CONNECT_ERROR')).toContain(
      'Unauthorized: session check failed',
    );
    expect((await c.closed).code).toBe(4401);
    expect(await s.hasClient(TEST_BROKEN_SESSION)).toBe(false);
  });

  it('dispatches each invocation to exactly one authenticated socket of its session, with its own id', async () => {
    const s = stub('single-dispatch');
    const older = await connect(s, { sessionId: 'one' });
    const newer = await connect(s, { sessionId: 'one' });
    const elsewhere = await connect(s, { sessionId: 'two' });

    const first = s.callBrowserTool({
      sessionId: 'one',
      toolCallId: 'tc-same',
      toolName: 'read_topic',
      args: {},
      timeoutMs: 5000,
    });
    const second = s.callBrowserTool({
      sessionId: 'one',
      toolCallId: 'tc-same',
      toolName: 'read_topic',
      args: {},
      timeoutMs: 5000,
    });
    // With no client activity yet, the connection opened last executes;
    // nobody else sees it.
    await newer.next(
      () => newer.frames.filter(isEvent('browser_tool_call')).length === 2,
      'two calls',
    );
    const [a, b] = newer.frames
      .filter(isEvent('browser_tool_call'))
      .map((f) => invocationOf(event(f).payload));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^tc-same:/);
    await roundTrip(older);
    await roundTrip(elsewhere);
    expect(older.frames.some(isEvent('browser_tool_call'))).toBe(false);
    expect(elsewhere.frames.some(isEvent('browser_tool_call'))).toBe(false);

    // Each result settles exactly its own invocation.
    answer(newer, 'tool_result', { toolCallId: b, result: 'second' });
    answer(newer, 'tool_result', { toolCallId: a, result: 'first' });
    expect(await first).toEqual({ ok: true, value: 'first' });
    expect(await second).toEqual({ ok: true, value: 'second' });
    for (const c of [older, newer, elsewhere]) c.ws.close(1000, 'bye');
  });

  it('never relays a frontend call frame that is not a dispatched invocation', async () => {
    const s = stub('no-raw-relay');
    const c = await connect(s, { sessionId: 'relay' });
    // The SSE stream mirrors the AG-UI sub-agent's own action_call frames
    // (isRunning, then done) to the taps; a plugin can emit one too. Neither
    // is an invocation: a browser that ran them would act twice.
    await s.emitForSession('relay', 'action_call', {
      requestId: 'r1',
      toolCallId: 'lc-run-1',
      toolName: 'render_table',
      args: {},
      status: 'isRunning',
    });
    await s.emitForSession('relay', 'browser_tool_call', {
      requestId: 'r1',
      toolCallId: 'tc-emitted',
      toolName: 'open_url',
      args: {},
    });
    await s.emitForSession('relay', 'tool_call', {
      requestId: 'r1',
      toolName: 'x',
      status: 'done',
    });
    await c.next(isEnvelope('tool_call'), 'ordinary event');
    expect(c.frames.some(isEvent('action_call'))).toBe(false);
    expect(c.frames.some(isEvent('browser_tool_call'))).toBe(false);
    expect(c.frames.some(isEnvelope('action_call'))).toBe(false);
    expect(c.frames.some(isEnvelope('browser_tool_call'))).toBe(false);
    c.ws.close(1000, 'bye');
  });

  it('refuses a call no socket can execute instead of waiting for a deadline', async () => {
    const s = stub('no-executor');
    expect(
      await s.callAgAction({
        sessionId: 'nobody-here',
        toolCallId: 'ag_x',
        toolName: 'render_table',
        args: {},
        timeoutMs: 5000,
      }),
    ).toEqual({
      ok: false,
      error:
        'AG-UI action render_table was not sent: no browser is connected to session nobody-here',
    });
    expect((await s.status()).pendingCalls).toEqual([]);
  });

  it('accepts a result only from the executing socket, without a session override, and only once', async () => {
    const s = stub('bound-result');
    const sibling = await connect(s, { sessionId: 'bound' });
    const executor = await connect(s, { sessionId: 'bound' });
    const call = s.callBrowserTool({
      sessionId: 'bound',
      toolCallId: 'tc-bound',
      toolName: 'mutate_topic',
      args: {},
      timeoutMs: 5000,
    });
    const id = invocationOf(
      event(await executor.next(isEvent('browser_tool_call'))).payload,
    );

    // Another tab of the same session and user knows the id: not its call.
    answer(sibling, 'tool_result', { toolCallId: id, result: 'sibling' });
    await roundTrip(sibling);
    // The executor naming another session is a routing claim it cannot make.
    answer(executor, 'tool_result', {
      toolCallId: id,
      sessionId: 'someone-else',
      result: 'override',
    });
    await roundTrip(executor);
    expect((await s.status()).pendingCalls).toMatchObject([
      { toolCallId: id, sessionId: 'bound' },
    ]);

    answer(executor, 'tool_result', {
      toolCallId: id,
      sessionId: 'bound',
      result: { commandId: 'c', status: 'completed' },
    });
    expect(await call).toEqual({
      ok: true,
      value: { commandId: 'c', status: 'completed' },
    });
    // The replay of a settled result is rejected, not re-delivered.
    answer(executor, 'tool_result', { toolCallId: id, result: 'replay' });
    await roundTrip(executor);

    const warnings = (await s.loggedWarnings()).filter((w) => w.includes(id));
    expect(warnings).toEqual([
      expect.stringContaining('not the socket it was sent to'),
      expect.stringContaining('names session someone-else'),
      expect.stringContaining('already settled'),
    ]);
    sibling.ws.close(1000, 'bye');
    executor.ws.close(1000, 'bye');
  });

  it('settles a call as unknown when its socket goes, and never re-sends it to another socket', async () => {
    const s = stub('no-redispatch');
    const survivor = await connect(s, { sessionId: 'nr' });
    const executor = await connect(s, { sessionId: 'nr' });
    const started = Date.now();
    const call = s.callBrowserTool({
      sessionId: 'nr',
      toolCallId: 'tc-drop',
      toolName: 'mutate_topic',
      args: {},
      timeoutMs: 30_000,
    });
    const id = invocationOf(
      event(await executor.next(isEvent('browser_tool_call'))).payload,
    );
    executor.ws.send('41');
    await executor.closed;
    // The write may have happened before the tab went: unknown, at once —
    // only that socket could ever have answered.
    expect(await call).toEqual({
      ok: true,
      value: expect.objectContaining({
        code: FRONTEND_OUTCOME_UNKNOWN,
        invocationId: id,
      }),
    });
    expect(Date.now() - started).toBeLessThan(10_000);

    // The reconnected tab (a new socket) cannot answer the old invocation,
    // and the surviving tab never received it.
    const reconnected = await connect(s, { sessionId: 'nr' });
    answer(reconnected, 'tool_result', { toolCallId: id, result: 'late' });
    await roundTrip(reconnected);
    await roundTrip(survivor);
    expect(survivor.frames.some(isEvent('browser_tool_call'))).toBe(false);
    expect(reconnected.frames.some(isEvent('browser_tool_call'))).toBe(false);
    expect(
      (await s.loggedWarnings()).some(
        (w) => w.includes(id) && w.includes('already'),
      ),
    ).toBe(true);
    survivor.ws.close(1000, 'bye');
    reconnected.ws.close(1000, 'bye');
  });

  it('settles a call as unknown when the heartbeat drops its socket', async () => {
    const s = stub('heartbeat-drop');
    const executor = await connect(s, { sessionId: 'hb' });
    const call = s.callBrowserTool({
      sessionId: 'hb',
      toolCallId: 'tc-hb',
      toolName: 'mutate_topic',
      args: {},
      timeoutMs: 30_000,
    });
    await executor.next(isEvent('browser_tool_call'));
    await s.ageSockets(180_000 + 60_000 + 1);
    expect(await s.pingTick()).toBeNull();
    expect(await call).toEqual({
      ok: true,
      value: expect.objectContaining({ code: FRONTEND_OUTCOME_UNKNOWN }),
    });
  });

  it('runs a call on the tab with the latest client activity, not the one that connected last', async () => {
    const s = stub('active-tab');
    const front = await connect(s, { sessionId: 'act' });
    const background = await connect(s, { sessionId: 'act' });
    // The user acts in the older tab after the other reconnected.
    await new Promise((r) => setTimeout(r, 5));
    await roundTrip(front);
    const call = s.callBrowserTool({
      sessionId: 'act',
      toolCallId: 'tc-active',
      toolName: 'read_topic',
      args: {},
      timeoutMs: 5000,
    });
    const id = invocationOf(
      event(await front.next(isEvent('browser_tool_call'))).payload,
    );
    answer(front, 'tool_result', { toolCallId: id, result: 'front' });
    expect(await call).toEqual({ ok: true, value: 'front' });
    await roundTrip(background);
    expect(background.frames.some(isEvent('browser_tool_call'))).toBe(false);
    front.ws.close(1000, 'bye');
    background.ws.close(1000, 'bye');
  });

  it('ends a call whose turn aborts: not sent before dispatch, unknown after', async () => {
    const s = stub('abort');
    const c = await connect(s, { sessionId: 'ab' });
    expect(
      await s.callBrowserToolAborted(
        {
          sessionId: 'ab',
          toolCallId: 'tc-before',
          toolName: 'mutate_topic',
          args: {},
          timeoutMs: 120_000,
        },
        'before',
      ),
    ).toEqual({
      ok: false,
      error: 'Browser tool mutate_topic was not sent: the turn was aborted',
    });
    const after = await s.callBrowserToolAborted(
      {
        sessionId: 'ab',
        toolCallId: 'tc-after',
        toolName: 'mutate_topic',
        args: {},
        timeoutMs: 120_000,
      },
      'after',
    );
    const id = invocationOf(
      event(await c.next(isEvent('browser_tool_call'))).payload,
    );
    await roundTrip(c);
    // Only the call sent before its turn aborted reached the browser.
    expect(c.frames.filter(isEvent('browser_tool_call'))).toHaveLength(1);
    expect(id).toMatch(/^tc-after:/);
    expect(after).toEqual({
      ok: true,
      value: expect.objectContaining({
        code: FRONTEND_OUTCOME_UNKNOWN,
        invocationId: id,
      }),
    });
    expect((await s.status()).pendingCalls).toEqual([]);
    c.ws.close(1000, 'bye');
  });

  it('shows a browser tool invocation on the SSE stream but not an AG-UI one, which the stream reports itself', async () => {
    const s = stub('sse-copy');
    const c = await connect(s, { sessionId: 'sse' });
    await s.watchSse('sse');
    const browser = s.callBrowserTool({
      sessionId: 'sse',
      toolCallId: 'tc-sse',
      toolName: 'open_url',
      args: {},
      timeoutMs: 5000,
    });
    const tc = invocationOf(
      event(await c.next(isEvent('browser_tool_call'))).payload,
    );
    answer(c, 'tool_result', { toolCallId: tc, result: 'ok' });
    await browser;
    const action = s.callAgAction({
      sessionId: 'sse',
      toolCallId: 'ag_sse',
      toolName: 'render_table',
      args: {},
      timeoutMs: 5000,
    });
    const ag = invocationOf(
      event(await c.next(isEvent('action_call'))).payload,
    );
    answer(c, 'action_call_result', {
      toolCallId: ag,
      result: { success: true },
    });
    await action;
    expect(await s.sseEvents()).toEqual([
      { eventName: 'browser_tool_call', toolCallId: tc },
    ]);
    c.ws.close(1000, 'bye');
  });
});

describe('RealtimeEndpoint before authentication', () => {
  it('validates one CONNECT at a time per socket: five CONNECTs in a burst authenticate once', async () => {
    const s = stub('connect-burst');
    const c = (await open(s)).client!;
    await c.next((f) => f.startsWith('0{'), 'OPEN');
    for (let i = 0; i < 5; i += 1)
      c.ws.send(`40${JSON.stringify({ invocation: TEST_SLOW_TOKEN })}`);
    await c.next(isEvent('connected'), 'connected');
    // Past the slow validation: any CONNECT that was let through would have
    // finished by now.
    await new Promise((r) => setTimeout(r, TEST_SLOW_AUTH_MS + 100));
    expect(await s.authenticationCount()).toBe(1);
    expect(c.frames.filter((f) => f.startsWith('40'))).toHaveLength(1);
    // Once authenticated, a CONNECT is acknowledged again without a new check.
    c.ws.send(`40${JSON.stringify({ invocation: TEST_SLOW_TOKEN })}`);
    await c.next(
      () => c.frames.filter((f) => f.startsWith('40')).length === 2,
      'second ack',
    );
    expect(await s.authenticationCount()).toBe(1);
    c.ws.close(1000, 'bye');
  });

  it('arms no heartbeat alarm for an upgrade that never authenticates; CONNECT arms it', async () => {
    const s = stub('no-alarm-before-auth');
    const anon = (await open(s)).client!;
    await anon.next((f) => f.startsWith('0{'), 'OPEN');
    expect(await s.alarmRequests()).toEqual([]);
    expect((await s.status()).nextPingAt).toBeNull();
    const refused = (await open(s)).client!;
    await refused.next((f) => f.startsWith('0{'), 'OPEN');
    refused.ws.send('40{"invocation":"wrong"}');
    await refused.closed;
    expect(await s.alarmRequests()).toEqual([]);

    const authed = await connect(s, { sessionId: 's-auth' });
    const requested = await s.alarmRequests();
    expect(requested).toHaveLength(1);
    expect(requested[0]).toBe((await s.status()).nextPingAt);
    anon.ws.close(1000, 'bye');
    authed.ws.close(1000, 'bye');
  });

  it('closes a socket whose frame exceeds the advertised maxPayload, before parsing it', async () => {
    const s = stub('oversized');
    const c = (await open(s)).client!;
    const openFrame = await c.next((f) => f.startsWith('0{'), 'OPEN');
    const { maxPayload } = JSON.parse(openFrame.slice(1)) as {
      maxPayload: number;
    };
    expect(maxPayload).toBe(MAX_PAYLOAD_BYTES);
    c.ws.send(
      `40${JSON.stringify({ invocation: TEST_GOOD_TOKEN, pad: 'x'.repeat(MAX_PAYLOAD_BYTES) })}`,
    );
    expect((await c.closed).code).toBe(1009);
    expect(await s.authenticationCount()).toBe(0);
    expect((await s.status()).sockets).toBe(0);
  });

  it('counts UTF-8 bytes against maxPayload, not characters', async () => {
    const s = stub('oversized-utf8');
    const c = (await open(s)).client!;
    await c.next((f) => f.startsWith('0{'), 'OPEN');
    // Under the limit in characters, over it in bytes ('é' is two).
    c.ws.send(
      `42["ping",${JSON.stringify('é'.repeat(MAX_PAYLOAD_BYTES / 2))}]`,
    );
    expect((await c.closed).code).toBe(1009);
  });
});

describe('RealtimeEndpoint after a restart', () => {
  it('closes a re-adopted socket that never authenticated once what was left of its handshake window passes', async () => {
    const s = stub('restored-unauthenticated');
    const c = (await open(s)).client!;
    await c.next((f) => f.startsWith('0{'), 'OPEN');
    // Its window has run out by the time a new instance re-adopts it; the
    // old instance's own timer would only fire seconds from now.
    await s.ageOpenedAt(HANDSHAKE_DEADLINE_MS);
    expect(await s.simulateWake()).toBe(1);
    const closed = await Promise.race([
      c.closed,
      new Promise<null>((r) => setTimeout(() => r(null), 2_000)),
    ]);
    expect(closed?.code).toBe(4408);
    expect(await s.alarmRequests()).toEqual([]);
  });
});

describe('RealtimeEndpoint heartbeat (alarm-driven, hibernation-safe)', () => {
  it('advertises the long ping cadence and asks for an alarm when a socket is accepted', async () => {
    const s = stub('hb-open');
    const client = await connect(s);
    const open = client.frames.find((f) => f.startsWith('0{'));
    const handshake = JSON.parse(String(open).slice(1)) as {
      pingInterval: number;
      pingTimeout: number;
    };
    expect(handshake.pingInterval).toBe(180_000);
    expect(handshake.pingTimeout).toBe(60_000);
    const status = await s.status();
    expect(status.pingIntervalMs).toBe(180_000);
    expect(status.nextPingAt).not.toBeNull();
    expect(status.socketDetails).toHaveLength(1);
    expect(status.socketDetails[0]?.lastPingAt).toBeNull();
    const requested = await s.alarmRequests();
    expect(requested.length).toBeGreaterThanOrEqual(1);
    expect(requested[0]).toBe(status.nextPingAt);
    client.ws.close(1000, 'done');
  });

  it('pings from the tick, records the pong, and survives a simulated wake', async () => {
    const s = stub('hb-tick');
    const client = await connect(s);
    const next = await s.pingTick();
    expect(next).not.toBeNull();
    await client.next((f) => f === '2', 'engine ping');
    const pinged = await s.status();
    expect(pinged.socketDetails[0]?.lastPingAt).not.toBeNull();
    const before = pinged.socketDetails[0]!.lastPongAt;
    await new Promise((r) => setTimeout(r, 5));
    client.ws.send('3');
    // The pong is processed by the object's webSocketMessage handler.
    let after = before;
    for (let i = 0; i < 20 && after === before; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      after = (await s.status()).socketDetails[0]!.lastPongAt;
    }
    expect(after).toBeGreaterThan(before);
    // Wake: the endpoint instance is dropped and rebuilt from the
    // hibernated sockets — bookkeeping intact, the socket still routable.
    expect(await s.simulateWake()).toBe(1);
    const woken = await s.status();
    expect(woken.socketDetails[0]?.lastPongAt).toBe(after);
    expect(woken.socketDetails[0]?.sessionId).toBe('s1');
    expect(woken.authenticated).toBe(1);
    await s.emitForSession('s1', 'tool_call', { toolName: 'x' });
    await client.next(isEnvelope('tool_call'), 'tool_call after wake');
    expect(await s.pingTick()).not.toBeNull();
    await client.next(
      (f) => client.frames.filter((x) => x === '2').length >= 2 && f === '2',
      'second ping',
    );
    client.ws.close(1000, 'done');
  });

  it('closes a socket that missed interval + timeout on the next tick', async () => {
    const s = stub('hb-timeout');
    const client = await connect(s);
    // Rewind the persisted pong so the next round sees it as expired.
    await s.ageSockets(180_000 + 60_000 + 1);
    expect(await s.pingTick()).toBeNull();
    const closed = await client.closed;
    expect(closed.code).toBe(4408);
    expect((await s.status()).sockets).toBe(0);
  });
  it('reports a session drained when its last authenticated socket goes', async () => {
    const s = stub('drain');
    const connect = async (sessionId: string) => {
      const { client } = await open(s, { sessionId });
      const c = client!;
      await c.next((f) => f.startsWith('0{'), 'OPEN');
      c.ws.send(`40${JSON.stringify({ invocation: TEST_GOOD_TOKEN })}`);
      await c.next((f) => f.startsWith('40'), 'CONNECT ack');
      return c;
    };
    const a = await connect('s-drain');
    const b = await connect('s-drain');
    const other = await connect('s-other');
    // A socket that never passed CONNECT leaves nothing to drain.
    const { client: anon } = await open(s, { sessionId: 's-anon' });
    anon!.ws.close(1000, 'bye');
    await new Promise((r) => setTimeout(r, 50));
    expect(await s.drainedSessions()).toEqual([]);

    a.ws.send('41');
    await a.closed;
    expect(await s.drainedSessions()).toEqual([]);

    b.ws.send('41');
    await b.closed;
    expect(await s.drainedSessions()).toEqual([
      { sessionId: 's-drain', userDid: TEST_USER_DID },
    ]);
    expect(await s.hasClient('s-other')).toBe(true);

    other.ws.send('41');
    await other.closed;
    expect(await s.drainedSessions()).toEqual([
      { sessionId: 's-drain', userDid: TEST_USER_DID },
      { sessionId: 's-other', userDid: TEST_USER_DID },
    ]);
  });
});
