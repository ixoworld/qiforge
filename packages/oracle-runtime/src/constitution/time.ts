/**
 * @fileoverview The clock authorization decisions are made against.
 *
 * Expiry, activation and revocation checks are only as trustworthy as the
 * clock behind them, so the source is named in every decision record rather
 * than left implicit. This runtime declares the system clock: honest about
 * what it is, and the seam where a network or chain time source is
 * substituted without touching the evaluator.
 */

/** Where a timestamp came from. Recorded verbatim on every decision. */
export type TimeSourceKind = 'system_clock' | 'network_time' | 'chain_time';

export interface TimeReading {
  /** RFC 3339 instant. */
  instant: string;
  /** Milliseconds since the epoch, for comparison. */
  epochMs: number;
  source: TimeSourceKind;
  /**
   * Whether the reading is trustworthy enough to decide on. A source that
   * cannot vouch for itself reports `false` and the evaluator fails closed
   * rather than treating an unknown clock as a good one.
   */
  trusted: boolean;
}

export interface TimeSource {
  now(): TimeReading;
}

/**
 * The host's wall clock.
 *
 * Marked trusted because a deployment has no better option today, not because
 * the clock is verified. Anything that needs real assurance — settlement,
 * long-lived delegation windows — should wait for an attested source.
 */
export const systemClock: TimeSource = {
  now(): TimeReading {
    const epochMs = Date.now();
    return {
      instant: new Date(epochMs).toISOString(),
      epochMs,
      source: 'system_clock',
      trusted: true,
    };
  },
};

/** A fixed clock, for tests and replay of a recorded decision. */
export function fixedClock(
  instant: string,
  options: { source?: TimeSourceKind; trusted?: boolean } = {},
): TimeSource {
  const epochMs = Date.parse(instant);
  if (Number.isNaN(epochMs)) {
    throw new Error(
      `fixedClock requires a parseable instant, received '${instant}'.`,
    );
  }
  return {
    now: () => ({
      instant: new Date(epochMs).toISOString(),
      epochMs,
      source: options.source ?? 'system_clock',
      trusted: options.trusted ?? true,
    }),
  };
}
