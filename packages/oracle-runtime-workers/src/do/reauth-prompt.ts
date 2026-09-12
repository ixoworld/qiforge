/**
 * The `ixo.oracle.delegation_required` prompt: when a room message arrives
 * and the user has no usable delegation, the object posts an event the web
 * app listens for to open its "authorize for Matrix" modal in place. It is
 * throttled per user (`UCAN_REAUTH_PROMPT_THROTTLE_SECONDS`) so the room is
 * not spammed while the user is away.
 *
 * The throttle is stamped only AFTER the homeserver accepted the event. The
 * earlier order — stamp, then send — turned a send lost to a gateway restart
 * into six hours of silence: the user kept messaging an oracle that could
 * not act, and nothing told them why. The send is retried across a restart
 * under one transaction id, so a response lost after the homeserver accepted
 * the event is deduplicated rather than posted twice; a second turn arriving
 * while a prompt is in flight joins it instead of posting another.
 */
import { retryTxnId } from '../matrix/txn-id';
import { retryGateway, type RetryGatewayOptions } from './gateway-retry';

export interface ReauthPromptDeps {
  throttleMs: number;
  /** When the last prompt was accepted (undefined = never). */
  getStamp(): Promise<number | undefined>;
  setStamp(at: number): Promise<void>;
  /** Post the event under the transaction id; resolves to its event id. */
  send(roomId: string, txnId: string): Promise<string>;
  /** Keeps the (un-awaited) prompt alive past the request that started it: `ctx.waitUntil`. */
  keepAlive(work: Promise<unknown>): void;
  log(message: string): void;
  warn(message: string): void;
  now?: () => number;
  retry?: Pick<RetryGatewayOptions, 'delaysMs' | 'sleep' | 'isTransient'>;
}

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export class ReauthPrompter {
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: ReauthPromptDeps) {}

  /** Prompt unless throttled or already in flight. Never rejects. */
  prompt(userDid: string, roomId: string): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = this.run(userDid, roomId)
      .catch((err: unknown) => {
        this.deps.warn(
          `[user-do] delegation-required event failed for ${userDid}: ${errorText(err)}`,
        );
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = run;
    this.deps.keepAlive(run);
    return run;
  }

  private async run(userDid: string, roomId: string): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    const last = await this.deps.getStamp();
    if (last !== undefined && now - last < this.deps.throttleMs) return;
    const txnId = retryTxnId('reauth');
    const eventId = await retryGateway(() => this.deps.send(roomId, txnId), {
      ...this.deps.retry,
      onRetry: (err, attempt, delayMs) =>
        this.deps.warn(
          `[user-do] delegation-required event send failed (attempt ${attempt}) — retrying in ${delayMs} ms: ${errorText(err)}`,
        ),
    });
    await this.deps.setStamp(this.deps.now?.() ?? Date.now());
    this.deps.log(
      `[user-do] sent ixo.oracle.delegation_required (${eventId}) to ${roomId} for ${userDid}`,
    );
  }
}
