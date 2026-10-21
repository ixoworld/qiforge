import type { BaseMessage } from '@langchain/core/messages';
import {
  stripTurnTimeNote,
  TURN_TIME_NOTE_KWARG,
} from '../../core/turn-time-note';
import { contentToText } from '../../do/transcript';

/** How many of the user's own messages count as evidence, and how much of each. */
export const EVIDENCE_MESSAGES = 8;
export const EVIDENCE_MESSAGE_CHARS = 4000;

/**
 * Words that make the latest message a question, a refusal or a thought
 * experiment rather than a request.
 */
export const NEGATION =
  /\b(don't|do not|never|not yet|what if|suppose|hypothetically)\b/i;

/**
 * The user's own words from the last few turns. The runtime's time note
 * (`Current time: … 14:05 …`) rides on every message the user sent; it is
 * stripped here so its digits can never stand in for an amount.
 */
export function userEvidence(messages: readonly BaseMessage[]): string[] {
  return messages
    .filter((m) => m.type === 'human')
    .slice(-EVIDENCE_MESSAGES)
    .map((m) =>
      contentToText(
        stripTurnTimeNote(
          m.content,
          m.additional_kwargs?.[TURN_TIME_NOTE_KWARG],
        ),
      ).slice(0, EVIDENCE_MESSAGE_CHARS),
    );
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/**
 * `value` written as a whole token: not inside a longer identifier, number
 * or id (`CARBON-1` is not evidence for `CARBON-10`, nor the reverse).
 */
export function mentionsToken(text: string, value: string): boolean {
  return new RegExp(`(?<![\\w.-])${escape(value)}(?![\\w.-])`).test(text);
}

/**
 * The amount with one of its units right beside it (`1.5 IXO`, `1.5IXO`,
 * `1500000 uixo`, `10 credits`, `10 CARBON-1`). A bare number is not
 * evidence: `14` in a clock time, `10` inside `CARBON-10` or `10.5`, and
 * `5 uixo` for a request of 5 IXO all fail here.
 */
export function mentionsAmount(
  text: string,
  amount: string,
  units: readonly string[],
): boolean {
  const unit = units.map(escape).join('|');
  return new RegExp(
    `(?<![\\w.,-])${escape(amount)}\\s*(?:${unit})(?![\\w-])`,
    'i',
  ).test(text);
}
