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
import { HumanMessage } from '@langchain/core/messages';
import { modelCallOf } from '../llm/model-call';
import type { ChannelFailureInfo } from '../plugin-api/oracle-plugin';
import { CHANNEL_DELIVERY_NOTICE_KWARG } from './replies';

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

/**
 * The text to send: a plugin's, the deployment's, or `fallback` (the busy
 * reply's default unless given).
 */
export async function busyReplyText(
  candidates: ReadonlyArray<
    () => string | undefined | Promise<string | undefined>
  >,
  configured: string | undefined,
  warn: (message: string) => void,
  fallback: string = CHANNEL_BUSY_REPLY_DEFAULT,
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
  return configured?.trim() || fallback;
}

// ---------------------------------------------------------------------------
// Empty replies.
//
// A channel turn whose model run ended with nothing to send (no text and no
// rich part: the model answered a tool result with an empty message) is
// never left silent. The model is asked once more, with
// {@link emptyReplyNudge} as a hidden note on the same thread; when that is
// empty too, the person gets the same short line as the busy reply (the
// plugin's `channelFailureReply`, told `kind: "empty_reply"`, else
// `CHANNEL_BUSY_REPLY`, else {@link CHANNEL_EMPTY_REPLY_DEFAULT}). No
// cooldown: it is one line per turn the person or an event started. An
// event turn is answered the same way: the gateway delivers an event turn
// only while the person's 24-hour WhatsApp window is open and checks the
// window again before it sends anything.

/** The `ChannelFailureInfo.kind` (and log code) of an empty model reply. */
export const EMPTY_REPLY_KIND = 'empty_reply';

/** The line sent when the model's reply stayed empty, unless a plugin or the deployment set one. */
export const CHANNEL_EMPTY_REPLY_DEFAULT =
  "Sorry, I couldn't finish my reply just now. Please send your message again.";

/** What the model is told when its reply had nothing in it for the person. */
export const EMPTY_REPLY_NUDGE =
  '[Runtime note, not a message from the user: your last step ended without any message for the person, so they received nothing. Reply to them now, in the language you were using with them: send what the last tool result says to tell them, or answer their last message. Do not call a tool again unless that is the only way to answer. Do not mention this note.]';

/**
 * The hidden note that asks the model once more. It rides as a delivery
 * notice, so every reader that shows the person's words (the transcript,
 * memory, session titles) skips it.
 */
export function emptyReplyNudge(at: Date = new Date()): HumanMessage {
  return new HumanMessage({
    content: EMPTY_REPLY_NUDGE,
    additional_kwargs: {
      timestamp: at.toISOString(),
      [CHANNEL_DELIVERY_NOTICE_KWARG]: EMPTY_REPLY_NUDGE,
    },
  });
}
