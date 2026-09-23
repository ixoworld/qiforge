export type FrontendCallKind = 'browser_tool_call' | 'action_call';
type FrontendResultKind = 'browser_tool_result' | 'action_call_result';
type FrontendSocket = {
  id: string;
  connected: boolean;
  data: { sessionId?: string; userDid?: string };
  emit(event: string, data: unknown): void;
};
type Invocation = {
  sessionId: string;
  socketId: string;
  userDid: string;
  kind: FrontendCallKind;
  expiresAt: number;
  completed: boolean;
};

/** One executor per invocation. Disconnects never cause automatic redispatch. */
export class FrontendInvocations {
  private readonly calls = new Map<string, Invocation>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly capacity = 4096,
  ) {}

  dispatch(
    kind: FrontendCallKind,
    value: unknown,
    sockets: Iterable<FrontendSocket>,
  ): boolean {
    if (
      !value ||
      typeof value !== 'object' ||
      !('sessionId' in value) ||
      typeof value.sessionId !== 'string' ||
      !('toolCallId' in value) ||
      typeof value.toolCallId !== 'string'
    )
      return false;
    const key = JSON.stringify([value.sessionId, value.toolCallId]);
    // Do not redeliver even after settlement or a disconnected executor.
    for (const [id, call] of this.calls)
      if (call.expiresAt < this.now()) this.calls.delete(id);
    if (this.calls.has(key)) return false;
    // Completed calls need only a bounded replay tombstone; they must not starve
    // new invocations. Pending calls are never evicted to make room.
    if (this.calls.size >= this.capacity) {
      for (const [id, call] of this.calls) {
        if (call.completed) this.calls.delete(id);
        if (this.calls.size < this.capacity) break;
      }
    }
    if (this.calls.size >= this.capacity) return false;
    const socket = Array.from(sockets).find(
      (candidate) =>
        candidate.connected &&
        candidate.data.sessionId === value.sessionId &&
        candidate.data.userDid,
    );
    if (!socket?.data.userDid) return false;
    this.calls.set(key, {
      sessionId: value.sessionId,
      socketId: socket.id,
      userDid: socket.data.userDid,
      kind,
      expiresAt: this.now() + 30 * 60_000,
      completed: false,
    });
    socket.emit(kind, value);
    return true;
  }

  accept(
    kind: FrontendResultKind,
    socket: FrontendSocket,
    sessionId: string,
    toolCallId: string,
  ): boolean {
    const call = this.calls.get(JSON.stringify([sessionId, toolCallId]));
    if (
      !call ||
      call.completed ||
      call.expiresAt < this.now() ||
      call.socketId !== socket.id ||
      call.sessionId !== socket.data.sessionId ||
      call.userDid !== socket.data.userDid ||
      (call.kind === 'browser_tool_call'
        ? 'browser_tool_result'
        : 'action_call_result') !== kind
    )
      return false;
    call.completed = true;
    return true;
  }
}
