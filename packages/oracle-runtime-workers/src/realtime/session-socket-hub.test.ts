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

  it('drops sockets whose send throws', () => {
    const hub = new SessionSocketHub<FakeSocket>();
    const dead = new FakeSocket(true);
    hub.add(dead, meta('s1', 'did:ixo:u'));
    expect(hub.emitToSession('s1', 'ev', 1)).toBe(0);
    expect(hub.size).toBe(0);
  });

  it('pings live sockets, closes the ones that stopped answering, and persists the bookkeeping', () => {
    let t = 1;
    const hub = new SessionSocketHub<FakeSocket>({ now: () => t });
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
});
