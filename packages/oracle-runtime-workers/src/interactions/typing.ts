export const TYPING_REFRESH_MS = 20_000;
export const TYPING_TIMEOUT_MS = 30_000;
const LEASE_MS = 60_000;
interface Lease {
  roomId: string;
  expires: number;
}
export class TypingLeases {
  private leases = new Map<string, Lease>();
  private rooms = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly send: (
      roomId: string,
      typing: boolean,
      timeout: number,
    ) => Promise<void>,
    private readonly now = Date.now,
    private readonly warn: (error: unknown) => void = () => undefined,
  ) {}
  set(
    key: string,
    roomId: string,
    active: boolean,
    expires = this.now() + LEASE_MS,
  ): void {
    if (active) this.leases.set(key, { roomId, expires });
    else this.leases.delete(key);
    if (this.leases.size && !this.timer)
      this.timer = setInterval(() => this.refresh(), TYPING_REFRESH_MS);
    this.refresh();
  }
  refresh(): void {
    for (const [key, lease] of this.leases)
      if (lease.expires <= this.now()) this.leases.delete(key);
    const next = new Set(
      [...this.leases.values()].map((lease) => lease.roomId),
    );
    const stopped = [...this.rooms].filter((roomId) => !next.has(roomId));
    this.rooms = next;
    // Serialized HTTP updates prevent a delayed false from overtaking a new true.
    this.chain = this.chain.then(async () => {
      for (const roomId of stopped)
        await this.send(roomId, false, TYPING_TIMEOUT_MS).catch(this.warn);
      for (const roomId of next)
        await this.send(roomId, true, TYPING_TIMEOUT_MS).catch(this.warn);
    });
    if (!this.leases.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
  settle(): Promise<void> {
    return this.chain;
  }
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.leases.clear();
    this.refresh();
  }
}
