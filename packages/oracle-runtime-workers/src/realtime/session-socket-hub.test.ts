import { describe, expect, it } from 'vitest';
import { SessionSocketHub, type HubSocket } from './session-socket-hub';

class FakeSocket implements HubSocket {
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private attachment: unknown = null;
  constructor(private readonly failSend = false) {}
  send(message: string): void {
    if (this.failSend) throw new Error('socket closed');
    this.sent.push(message);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  serializeAttachment(value: unknown): void {
    this.attachment = JSON.parse(JSON.stringify(value));
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

const meta = (sessionId: string, userDid?: string) => ({
  sid: `sid-${sessionId}`,
  sessionId,
  routedUserDid: 'did:ixo:u',
  ...(userDid ? { userDid } : {}),
  openedAt: 1,
  lastPongAt: 1,
});

describe('SessionSocketHub', () => {
  it('routes events to the authenticated sockets of a session only', () => {
    const hub = new SessionSocketHub<FakeSocket>();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const pending = new FakeSocket();
    hub.add(a, meta('s1', 'did:ixo:u'));
    hub.add(b, meta('s2', 'did:ixo:u'));
    hub.add(pending, meta('s1'));
    expect(hub.emitToSession('s1', 'tool_call', { x: 1 })).toBe(1);
    expect(a.sent).toEqual(['42["tool_call",{"x":1}]']);
    expect(b.sent).toEqual([]);
    expect(pending.sent).toEqual([]);
    expect(hub.hasSession('s1')).toBe(true);
    expect(hub.hasSession('s3')).toBe(false);
    expect(hub.sessionCount()).toBe(2);
    expect(hub.connectionCount()).toBe(2);
    expect(hub.size).toBe(3);
  });

  it('persists identity on the socket and restores it after a restart', () => {
    const hub = new SessionSocketHub<FakeSocket>();
    const a = new FakeSocket();
    hub.add(a, meta('s1'));
    hub.update(a, { userDid: 'did:ixo:u' });
    const stray = new FakeSocket();
    const restored = new SessionSocketHub<FakeSocket>();
    expect(restored.restore([a, stray])).toBe(1);
    expect(restored.get(a)?.userDid).toBe('did:ixo:u');
    expect(stray.closed?.code).toBe(1011);
    expect(restored.emitToSession('s1', 'ev', null)).toBe(1);
  });

  it('drops sockets whose send throws and reports them', () => {
    const dropped: string[] = [];
    const hub = new SessionSocketHub<FakeSocket>({
      onDropped: (attachment) => dropped.push(attachment.sid),
    });
    const dead = new FakeSocket(true);
    hub.add(dead, meta('s1', 'did:ixo:u'));
    expect(hub.emitToSession('s1', 'ev', 1)).toBe(0);
    expect(hub.size).toBe(0);
    expect(dropped).toEqual(['sid-s1']);
  });

  it('runs frontend calls on the most recently active tab, else the one opened last', () => {
    let t = 10;
    const hub = new SessionSocketHub<FakeSocket>({ now: () => t });
    const older = new FakeSocket();
    const newer = new FakeSocket();
    const unauthenticated = new FakeSocket();
    const otherSession = new FakeSocket();
    hub.add(older, { ...meta('s1', 'did:ixo:u'), sid: 'old', openedAt: 1 });
    hub.add(newer, { ...meta('s1', 'did:ixo:u'), sid: 'new', openedAt: 2 });
    hub.add(unauthenticated, { ...meta('s1'), sid: 'anon', openedAt: 3 });
    hub.add(otherSession, { ...meta('s2', 'did:ixo:u'), openedAt: 4 });
    // No client activity yet: the tab that connected last.
    expect(hub.executorFor('s1', 'browser', 'open_url')?.socket).toBe(newer);
    // The older tab is the one the user acted in last.
    hub.noteActivity(older);
    expect(hub.executorFor('s1', 'browser', 'open_url')?.socket).toBe(older);
    // Persisted on the attachment, so a wake from hibernation keeps it.
    expect(
      (older.deserializeAttachment() as { lastActiveAt?: number }).lastActiveAt,
    ).toBe(10);
    t = 20;
    hub.noteActivity(newer);
    expect(hub.executorFor('s1', 'browser', 'open_url')?.socket).toBe(newer);
    expect(hub.executorFor('s3', 'browser', 'open_url')).toBeUndefined();
  });

  it('prefers any foreground tab, else a background executor that declared the tool, by recency', () => {
    let t = 10;
    const hub = new SessionSocketHub<FakeSocket>({ now: () => t });
    const reader = new FakeSocket();
    const writer = new FakeSocket();
    const late = new FakeSocket();
    const background = (sid: string, tools: string[], openedAt: number) => ({
      ...meta('s1', 'did:ixo:u'),
      sid,
      openedAt,
      executor: 'background' as const,
      tools,
    });
    hub.add(reader, background('reader', ['read_vault', 'find_entity'], 1));
    hub.add(writer, background('writer', ['mutate_topic'], 2));
    hub.add(late, background('late', ['find_entity'], 3));
    // Only a background executor that declared the tool can run it, and
    // never as an AG-UI action.
    expect(hub.executorFor('s1', 'browser', 'read_vault')?.socket).toBe(reader);
    expect(hub.executorFor('s1', 'agui', 'read_vault')).toBeUndefined();
    expect(hub.executorFor('s1', 'browser', 'mutate_topic')?.socket).toBe(
      writer,
    );
    expect(hub.executorFor('s1', 'browser', 'open_url')).toBeUndefined();
    // Among the ones that can, the most recent (opened last, then activity).
    expect(hub.executorFor('s1', 'browser', 'find_entity')?.socket).toBe(late);
    hub.noteActivity(reader);
    expect(hub.executorFor('s1', 'browser', 'find_entity')?.socket).toBe(
      reader,
    );
    // A foreground tab wins for every tool, even an older, idle one.
    const tab = new FakeSocket();
    hub.add(tab, { ...meta('s1', 'did:ixo:u'), sid: 'tab', openedAt: 0 });
    t = 30;
    hub.noteActivity(late);
    for (const tool of ['read_vault', 'find_entity', 'open_url'])
      expect(hub.executorFor('s1', 'browser', tool)?.socket).toBe(tab);
    expect(hub.executorFor('s1', 'agui', 'render_table')?.socket).toBe(tab);
    // Not authenticated: runs nothing.
    const anon = new FakeSocket();
    hub.add(anon, { ...meta('s2'), executor: 'background', tools: ['x'] });
    expect(hub.executorFor('s2', 'browser', 'x')).toBeUndefined();
  });

  it('fans events out to foreground tabs only, while every authenticated executor counts for the session', () => {
    const hub = new SessionSocketHub<FakeSocket>();
    const background = new FakeSocket();
    hub.add(background, {
      ...meta('s1', 'did:ixo:u'),
      sid: 'bg',
      executor: 'background',
      tools: ['read_vault'],
    });
    expect(hub.emitToSession('s1', 'tool_call', { x: 1 })).toBe(0);
    expect(background.sent).toEqual([]);
    expect(hub.hasSession('s1')).toBe(true);
    expect(hub.forSession('s1')).toEqual([background]);
    expect(hub.hasForegroundSession('s1')).toBe(false);
    expect(hub.sessionCount()).toBe(1);
    expect(hub.connectionCount()).toBe(1);

    const tab = new FakeSocket();
    hub.add(tab, { ...meta('s1', 'did:ixo:u'), sid: 'tab' });
    expect(hub.hasForegroundSession('s1')).toBe(true);
    expect(hub.emitToSession('s1', 'tool_call', { x: 2 })).toBe(1);
    expect(tab.sent).toEqual(['42["tool_call",{"x":2}]']);
    expect(background.sent).toEqual([]);
    expect(hub.connectionCount()).toBe(2);
  });

  it('encodes an event only when a foreground socket of the session will take it, and once for all of them', () => {
    const hub = new SessionSocketHub<FakeSocket>();
    const background = new FakeSocket();
    hub.add(background, {
      ...meta('s1', 'did:ixo:u'),
      sid: 'bg',
      executor: 'background',
      tools: ['read_vault'],
    });
    hub.add(new FakeSocket(), meta('s2', 'did:ixo:u'));
    // JSON.stringify throws on a BigInt: reaching the encoder would throw.
    const unencodable = { n: 1n };
    expect(hub.emitToSession('s1', 'tool_call', unencodable)).toBe(0);
    expect(hub.emitToSession('nobody', 'tool_call', unencodable)).toBe(0);
    expect(() => hub.emitToSession('s2', 'tool_call', unencodable)).toThrow();

    const tabs = [new FakeSocket(), new FakeSocket()];
    tabs.forEach((tab, i) =>
      hub.add(tab, { ...meta('s1', 'did:ixo:u'), sid: `tab-${i}` }),
    );
    const payload = { x: 1 };
    let reads = 0;
    Object.defineProperty(payload, 'x', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 1;
      },
    });
    expect(hub.emitToSession('s1', 'tool_call', payload)).toBe(2);
    expect(reads).toBe(1);
    for (const tab of tabs)
      expect(tab.sent).toEqual(['42["tool_call",{"x":1}]']);
    expect(background.sent).toEqual([]);
  });

  it('keeps the executor kind and tools on the attachment across a restart', () => {
    const hub = new SessionSocketHub<FakeSocket>();
    const background = new FakeSocket();
    hub.add(background, meta('s1'));
    hub.update(background, {
      userDid: 'did:ixo:u',
      executor: 'background',
      tools: ['read_vault'],
    });
    const woken = new SessionSocketHub<FakeSocket>();
    expect(woken.restore([background])).toBe(1);
    expect(woken.get(background)).toMatchObject({
      executor: 'background',
      tools: ['read_vault'],
    });
    expect(woken.executorFor('s1', 'browser', 'read_vault')?.socket).toBe(
      background,
    );
    expect(woken.emitToSession('s1', 'ev', null)).toBe(0);
  });

  it('pings live sockets, closes the ones that stopped answering, and persists the bookkeeping', () => {
    let t = 1;
    const dropped: string[] = [];
    const hub = new SessionSocketHub<FakeSocket>({
      now: () => t,
      onDropped: (attachment) => dropped.push(attachment.sid),
    });
    const live = new FakeSocket();
    const silent = new FakeSocket();
    hub.add(live, meta('s1', 'did:ixo:u'));
    hub.add(silent, meta('s1', 'did:ixo:u'));
    // First round is due one interval after open.
    expect(hub.nextPingAt(180_000)).toBe(180_001);
    t = 180_001;
    expect(hub.heartbeat(180_000, 60_000)).toEqual([]);
    expect(live.sent).toEqual(['2']);
    expect(silent.sent).toEqual(['2']);
    // The ping time is on the attachment (survives hibernation).
    expect(
      (live.deserializeAttachment() as { lastPingAt?: number }).lastPingAt,
    ).toBe(180_001);
    expect(hub.nextPingAt(180_000)).toBe(360_001);
    // Only `live` answers.
    t = 180_500;
    hub.notePong(live);
    expect(
      (live.deserializeAttachment() as { lastPongAt: number }).lastPongAt,
    ).toBe(180_500);
    // Next round: `silent`'s last pong (t=1) is older than interval + timeout.
    t = 360_001;
    const closed = hub.heartbeat(180_000, 60_000);
    expect(closed).toEqual([silent]);
    expect(silent.closed?.code).toBe(4408);
    expect(dropped).toEqual(['sid-s1']);
    expect(hub.size).toBe(1);
    expect(live.sent).toEqual(['2', '2']);
    // No sockets → no round due.
    hub.remove(live);
    expect(hub.nextPingAt(180_000)).toBeNull();
  });

  it('restores the heartbeat bookkeeping from the attachment (and defaults it for old attachments)', () => {
    const hub = new SessionSocketHub<FakeSocket>({ now: () => 1 });
    const a = new FakeSocket();
    hub.add(a, meta('s1', 'did:ixo:u'));
    hub.heartbeat(180_000, 60_000);
    const legacy = new FakeSocket();
    legacy.serializeAttachment({
      sid: 'old',
      sessionId: 's2',
      routedUserDid: 'did:ixo:u',
      userDid: 'did:ixo:u',
      openedAt: 1,
    });
    const woken = new SessionSocketHub<FakeSocket>({ now: () => 500 });
    expect(woken.restore([a, legacy])).toBe(2);
    expect(woken.get(a)?.lastPingAt).toBe(1);
    expect(woken.get(a)?.lastPongAt).toBe(1);
    expect(woken.get(legacy)?.lastPongAt).toBe(500);
    expect(woken.get(legacy)?.lastPingAt).toBeUndefined();
    // The legacy socket has never been pinged: due one interval after open.
    expect(woken.nextPingAt(180_000)).toBe(180_001);
  });

  it('schedules no heartbeat round for a socket that has not authenticated', () => {
    const hub = new SessionSocketHub<FakeSocket>({ now: () => 1 });
    const pending = new FakeSocket();
    hub.add(pending, meta('s1'));
    expect(hub.nextPingAt(180_000)).toBeNull();
    hub.update(pending, { userDid: 'did:ixo:u' });
    expect(hub.nextPingAt(180_000)).toBe(180_001);
  });
});
