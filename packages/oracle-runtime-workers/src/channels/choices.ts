/**
 * Choices an oracle offered as reply buttons or a list, kept per session for
 * a day so a tap can be checked: a channel turn's `choice.id` counts only
 * when this session offered it in the last 24 hours. Anything else (an
 * unknown, stale or foreign id) reads as what the person typed.
 */
import { z } from 'zod';
import type { DoSqliteDatabase } from '../sqlite/database';
import { parseChoiceId } from '../delivery/rich';
import type { ReplyPlan } from '../delivery/types';

const StoredOptions = z.array(z.object({ id: z.string(), title: z.string() }));

/** How long a tap on an offered choice counts. */
export const CHOICE_TTL_MS = 24 * 60 * 60 * 1000;

/** The option a person tapped, as the run reads it. */
export interface TappedChoice {
  /** The tapped id, `oc:<offer>:<key>`. */
  id: string;
  /** The option's id as the model or plugin gave it (`key`). */
  key: string;
  title: string;
  /** The question the option belonged to. */
  question: string;
}

export class ChannelChoices {
  private ready: Promise<void> | undefined;

  constructor(
    private readonly db: DoSqliteDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  private setup(): Promise<void> {
    this.ready ??= this.db
      .run(
        `CREATE TABLE IF NOT EXISTS channel_choice_offers (
          session_id TEXT NOT NULL, offer_id TEXT NOT NULL,
          question TEXT NOT NULL, options_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(session_id, offer_id)
        )`,
      )
      .then(() => undefined);
    return this.ready;
  }

  /** Keep the choices a finished run's plan offered; drop expired offers. */
  async record(sessionId: string, plan: ReplyPlan): Promise<number> {
    const offers = plan.parts.flatMap((part) => {
      if (part.kind !== 'choices') return [];
      const offerId = parseChoiceId(part.choices.options[0]?.id ?? '')?.offerId;
      return offerId
        ? [
            {
              offerId,
              question: part.choices.body,
              options: part.choices.options,
            },
          ]
        : [];
    });
    if (offers.length === 0) return 0;
    await this.setup();
    const now = this.now();
    await this.db.run(
      'DELETE FROM channel_choice_offers WHERE created_at < ?',
      [now - CHOICE_TTL_MS],
    );
    for (const offer of offers)
      await this.db.run(
        'INSERT OR REPLACE INTO channel_choice_offers (session_id, offer_id, question, options_json, created_at) VALUES (?, ?, ?, ?, ?)',
        [
          sessionId,
          offer.offerId,
          offer.question,
          JSON.stringify(offer.options),
          now,
        ],
      );
    return offers.length;
  }

  /** The tapped option, when this session offered it within `CHOICE_TTL_MS`; else null. */
  async resolve(sessionId: string, id: string): Promise<TappedChoice | null> {
    const parsed = parseChoiceId(id);
    if (!parsed) return null;
    await this.setup();
    const row = await this.db.get<{
      question: string;
      options_json: string;
      created_at: number;
    }>(
      'SELECT question, options_json, created_at FROM channel_choice_offers WHERE session_id = ? AND offer_id = ?',
      [sessionId, parsed.offerId],
    );
    if (!row || Number(row.created_at) < this.now() - CHOICE_TTL_MS)
      return null;
    let options: z.infer<typeof StoredOptions>;
    try {
      const stored = StoredOptions.safeParse(JSON.parse(row.options_json));
      if (!stored.success) return null;
      options = stored.data;
    } catch {
      return null;
    }
    const option = options.find((o) => o.id === id);
    if (!option) return null;
    return { id, key: parsed.key, title: option.title, question: row.question };
  }
}
