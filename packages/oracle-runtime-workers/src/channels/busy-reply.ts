/**
 * The one short message a channel user (WhatsApp) gets when their turn
 * failed because the model could not be reached: every provider and
 * fallback of the call failed, the platform key hit its limit (402/403), or
 * the call timed out. It replaces the gateway's generic failure reply
 * (which an event turn never gets), in the person's language when a plugin
 * knows it.
 *
 * - Only a model failure counts: the error carries the failed call's record
 *   (`modelCallOf`). A tool or runtime failure keeps the run `failed`.
 * - At most one message per chat (channel binding) per
 *   `CHANNEL_BUSY_REPLY_COOLDOWN_MS`. A failure inside that time ends the
 *   run with nothing to send, so the gateway sends nothing either (it would
 *   send its own failure reply for a `failed` run). Nothing is retried: the
 *   run ends here.
 * - The run ends `finished` with the message as its plan, like a run that
 *   failed after sending files; the run row keeps the error. The checkpoint
 *   is not touched, so the model never reads the message as its own words.
 * - An event turn reaches the oracle only while the person's 24-hour
 *   WhatsApp window is open (the gateway drops the event otherwise), and the
 *   gateway checks the window again before it sends anything.
 *
 * The text: the first plugin's `channelFailureReply` (in the person's
 * language, when the plugin keeps one), else `CHANNEL_BUSY_REPLY`, else
 * {@link CHANNEL_BUSY_REPLY_DEFAULT}.
 */
import { modelCallOf } from '../llm/model-call';
import type { ChannelFailureInfo } from '../plugin-api/oracle-plugin';

export const CHANNEL_BUSY_REPLY_DEFAULT =
  "Sorry, I'm a bit busy right now. Please try again in a few minutes.";

/** One busy reply per chat in this window. */
export const CHANNEL_BUSY_REPLY_COOLDOWN_MS = 10 * 60 * 1000;

/** Storage key of the last busy reply sent to a channel binding. */
export function busyReplyKey(bindingId: string): string {
  return `channel-busy-reply:${bindingId}`;
}

/** The model failure a run's error reports, or null when it is not one. */
export function modelFailureOf(error: unknown): ChannelFailureInfo | null {
  const call = modelCallOf(error);
  if (!call || call.ok) return null;
  return {
    kind: call.errorKind ?? 'unknown',
    ...(call.errorStatus !== undefined ? { status: call.errorStatus } : {}),
  };
}

/** Whether a busy reply may go out now, given when the last one did. */
export function busyReplyDue(
  lastSentAt: number | undefined,
  now: number,
): boolean {
  return (
    lastSentAt === undefined ||
    now - lastSentAt >= CHANNEL_BUSY_REPLY_COOLDOWN_MS
  );
}

/** The text to send: a plugin's, the deployment's, or the default. */
export async function busyReplyText(
  candidates: ReadonlyArray<
    () => string | undefined | Promise<string | undefined>
  >,
  configured: string | undefined,
  warn: (message: string) => void,
): Promise<string> {
  for (const candidate of candidates) {
    try {
      const text = (await candidate())?.trim();
      if (text) return text;
    } catch (error) {
      warn(
        `[channels] a plugin's channelFailureReply failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return configured?.trim() || CHANNEL_BUSY_REPLY_DEFAULT;
}
