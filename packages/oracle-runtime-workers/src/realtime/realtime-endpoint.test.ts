/**
 * The socket.io endpoint end to end inside workerd: a real WebSocket pair
 * through `RealtimeTestDO` (`test/wrangler.test.jsonc`), the wire protocol
 * as `socket.io-client` speaks it, auth in the CONNECT packet, fan-out
 * through the router, and browser-tool / AG-UI round trips.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  TEST_GOOD_TOKEN,
  TEST_MISSING_SESSION,
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

  it('fans runtime events out to the session that owns them only', async () => {
    const s = stub('fanout');
    const a = await connect(s, { sessionId: 'sa' });
    const b = await connect(s, { sessionId: 'sb' });
    await s.emitForSession('sa', 'tool_call', {
      toolName: 'x',
      status: 'done',
    });
    await s.emitForSession('sb', 'render_component', { component: 'card' });
    const toA = event(await a.next(isEvent('tool_call')));
    expect(toA.payload).toEqual({
      toolName: 'x',
      status: 'done',
      sessionId: 'sa',
    });
    const toB = event(await b.next(isEvent('render_component')));
    expect(toB.payload).toEqual({ component: 'card', sessionId: 'sb' });
    expect(a.frames.some(isEvent('render_component'))).toBe(false);
    expect(b.frames.some(isEvent('tool_call'))).toBe(false);
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
    expect(call.payload).toEqual({
      sessionId: 'rt',
      requestId: 'tc-1',
      toolCallId: 'tc-1',
      toolName: 'open_url',
      args: { url: 'https://example.com' },
    });
    c.ws.send(
      '42["tool_result",{"toolCallId":"tc-1","result":{"opened":true}}]',
    );
    expect(await browser).toEqual({ ok: true, value: { opened: true } });

    const failing = s.callBrowserTool({
      sessionId: 'rt',
      toolCallId: 'tc-2',
      toolName: 'open_url',
      args: {},
      timeoutMs: 5000,
    });
    await c.next((f) => f.includes('"tc-2"'));
    c.ws.send(
      '42["tool_result",{"toolCallId":"tc-2","result":null,"error":"Tool open_url not found"}]',
    );
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
    expect(actionCall.payload).toMatchObject({
      toolCallId: 'ag_1',
      toolName: 'render_table',
      args: { rows: 2 },
      status: 'isRunning',
    });
    c.ws.send(
      '42["action_call_result",{"toolCallId":"ag_1","sessionId":"rt","result":{"success":true,"id":"t1"}}]',
    );
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
    await c.next((f) => f.includes('"ag_2"'));
    c.ws.send(
      '42["action_call_result",{"toolCallId":"ag_2","result":{"success":false,"error":"render failed"}}]',
    );
    expect(await refused).toEqual({ ok: false, error: 'render failed' });

    // No answer → Node's timeout message.
    expect(
      await s.callBrowserTool({
        sessionId: 'rt',
        toolCallId: 'tc-3',
        toolName: 'slow_tool',
        args: {},
        timeoutMs: 50,
      }),
    ).toEqual({
      ok: false,
      error: 'Browser tool timeout after 50ms: slow_tool',
    });
    expect((await s.status()).pendingCalls).toEqual([]);
    c.ws.close(1000, 'bye');
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
    await client.next(isEvent('tool_call'), 'tool_call after wake');
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
