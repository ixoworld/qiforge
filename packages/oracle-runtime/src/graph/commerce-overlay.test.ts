import { describe, expect, it } from 'vitest';
import type { CommerceEngagement } from '../plugin-api/types.js';
import { buildCommerceOverlay } from './commerce-overlay.js';

const ENGAGEMENT: CommerceEngagement = {
  status: 'active',
  serviceId: 'tax-report',
  serviceName: 'Tax report',
  priceUsd: 20,
  collectionId: '42',
  adminAddress: 'ixo1admin',
  startedAt: '2026-07-22T00:00:00.000Z',
};

const HOUR_MS = 60 * 60 * 1000;

/** An engagement whose reservation window runs `windowMs`, `leftMs` of it left. */
function withIntentWindow(
  windowMs: number,
  leftMs: number,
): CommerceEngagement {
  const expiresAt = Date.now() + leftMs;
  return {
    ...ENGAGEMENT,
    startedAt: new Date(expiresAt - windowMs).toISOString(),
    intent: {
      txHash: 'INTENT-TX-1',
      submittedAt: new Date(expiresAt - windowMs).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    },
  };
}

/** A line only the shared primer carries. */
const PRIMER_MARKER = 'You are a paid agent.';

describe('buildCommerceOverlay — shared primer', () => {
  it('explains the commercial model in both modes', () => {
    for (const overlay of [
      buildCommerceOverlay({ mode: 'support' }),
      buildCommerceOverlay({ mode: 'work', engagement: ENGAGEMENT }),
    ]) {
      expect(overlay).toContain(PRIMER_MARKER);
      expect(overlay).toContain('Agent Card');
      expect(overlay).toContain('done means');
      expect(overlay).toContain('on-chain authorization');
      expect(overlay).toContain('never perform contracted work');
      expect(overlay).toContain('reserved on-chain');
      expect(overlay).toContain('independent evaluator');
      expect(overlay).toContain('Honesty is enforced');
      expect(overlay).toContain('Conversation is free');
    }
  });

  it('renders the primer exactly once, gate reason or not', () => {
    const occurrences = (text: string) => text.split(PRIMER_MARKER).length - 1;

    expect(occurrences(buildCommerceOverlay({ mode: 'support' }))).toBe(1);
    expect(
      occurrences(
        buildCommerceOverlay({
          mode: 'support',
          gate: {
            reason: 'not_contracted',
            serviceId: 'tax-report',
            serviceName: 'Tax report',
          },
        }),
      ),
    ).toBe(1);
    expect(
      occurrences(
        buildCommerceOverlay({ mode: 'work', engagement: ENGAGEMENT }),
      ),
    ).toBe(1);
  });
});

describe('buildCommerceOverlay', () => {
  it('frames the support persona with attachment + threads guidance', () => {
    const overlay = buildCommerceOverlay({ mode: 'support' });

    expect(overlay).toContain('front desk');
    expect(overlay).toContain('Never perform the contracted service');
    expect(overlay).toContain('images and files the user shares');
    expect(overlay).toContain('its own thread');
    // The support tool set follows from the primer.
    expect(overlay).toContain('`list_services`');
    expect(overlay).toContain('`show_contract`');
    expect(overlay).toContain('`get_contract_status`');
    // Work tools are not exposed in support mode — do not advertise them.
    expect(overlay).not.toContain('deliver_work');
  });

  it('frames the work persona around the active engagement, deliver_work, and cancel_work', () => {
    const overlay = buildCommerceOverlay({
      mode: 'work',
      engagement: ENGAGEMENT,
    });

    expect(overlay).toContain('`tax-report`');
    expect(overlay).toContain('Tax report');
    expect(overlay).toContain('active contract');
    expect(overlay).toContain('`deliver_work`');
    // Cancellation is an agent decision — the overlay must route it to the tool.
    expect(overlay).toContain('`cancel_work`');
    expect(overlay).toContain('never silently stop');
    // Shared guidance rides along in BOTH modes.
    expect(overlay).toContain('images and files the user shares');
    expect(overlay).toContain('its own thread');
  });

  it('appends the gate-failure instruction with reason and show_contract target', () => {
    const overlay = buildCommerceOverlay({
      mode: 'support',
      gate: {
        reason: 'quota_exhausted',
        serviceId: 'tax-report',
        serviceName: 'Tax report',
      },
    });

    expect(overlay).toContain('no usable contract');
    expect(overlay).toContain('quota_exhausted');
    expect(overlay).toContain('`show_contract`');
    expect(overlay).toContain('`tax-report`');
  });

  it('renders engagement_in_progress as a one-job-at-a-time refusal, not a contracting or transient one', () => {
    const overlay = buildCommerceOverlay({
      mode: 'support',
      gate: {
        reason: 'engagement_in_progress',
        serviceId: 'tax-report',
        serviceName: 'Tax report',
        inProgress: {
          serviceId: 'bookkeeping',
          serviceName: 'Bookkeeping cleanup',
          threadId: '$other-thread:home',
        },
      },
    });

    expect(overlay).toContain('already has a paid job in progress');
    // The running job is named, and located, so the model can point at it.
    expect(overlay).toContain('"Bookkeeping cleanup"');
    expect(overlay).toContain('$other-thread:home');
    expect(overlay).toContain('Only one paid job can run at a time');
    expect(overlay).toContain('`cancel_work`');
    // The contract is fine and waiting does not help — say neither.
    expect(overlay).not.toContain('no usable contract');
    expect(overlay).toContain('do not call `show_contract`');
    expect(overlay).toContain('do not tell them to try again shortly');
  });

  it('tells the model to retry cancel_work when a release never reached the chain', () => {
    const overlay = buildCommerceOverlay({
      mode: 'support',
      gate: {
        reason: 'engagement_in_progress',
        serviceId: 'tax-report',
        serviceName: 'Tax report',
        inProgress: {
          serviceId: 'bookkeeping',
          serviceName: 'Bookkeeping cleanup',
          threadId: '$other-thread:home',
          releaseFailed: true,
        },
      },
    });

    expect(overlay).toContain('still holding its on-chain payment reservation');
    expect(overlay).toContain('cancellation did not complete');
    expect(overlay).toContain('`cancel_work` again');
    expect(overlay).toContain('$other-thread:home');
    // Nobody is working on it, so "wait for it to finish" would be a lie.
    expect(overlay).not.toContain('wait for it to finish');
    expect(overlay).toContain('do not call `show_contract`');
  });

  it('names the requested service even when the blocking job is unknown', () => {
    const overlay = buildCommerceOverlay({
      mode: 'support',
      gate: { reason: 'engagement_in_progress', serviceId: 'tax-report' },
    });

    expect(overlay).toContain('"tax-report"');
    expect(overlay).toContain('another job');
    expect(overlay).not.toContain('thread root');
  });

  it('treats intent_failed as a payment problem, not a contracting one', () => {
    const overlay = buildCommerceOverlay({
      mode: 'support',
      gate: {
        reason: 'intent_failed',
        serviceId: 'tax-report',
        serviceName: 'Tax report',
      },
    });

    expect(overlay).toContain('IS contracted');
    expect(overlay).toContain('reserving the payment on-chain just failed');
    expect(overlay).toContain('ask again shortly');
    // The user already holds a contract — a contract card would be nonsense.
    expect(overlay).toContain('do not call `show_contract`');
    expect(overlay).not.toContain('no usable contract');
  });
});

describe('buildCommerceOverlay — reservation deadline', () => {
  it('stays quiet while most of the window remains', () => {
    const overlay = buildCommerceOverlay({
      mode: 'work',
      engagement: withIntentWindow(10 * HOUR_MS, 9 * HOUR_MS),
    });

    expect(overlay).not.toContain('releases at');
    expect(overlay).not.toContain('expired at');
  });

  it('warns to wrap up once the window is nearly spent', () => {
    const engagement = withIntentWindow(10 * HOUR_MS, HOUR_MS);
    const overlay = buildCommerceOverlay({ mode: 'work', engagement });

    expect(overlay).toContain(
      `releases at ${engagement.intent!.expiresAt!} and this job`,
    );
    expect(overlay).toContain('close to that deadline');
    expect(overlay).toContain('`deliver_work`');
  });

  it('tells the model to stop once the window has passed', () => {
    const engagement = withIntentWindow(10 * HOUR_MS, -HOUR_MS);
    const overlay = buildCommerceOverlay({ mode: 'work', engagement });

    expect(overlay).toContain(`expired at ${engagement.intent!.expiresAt!}`);
    expect(overlay).toContain('Do not keep working');
    expect(overlay).toContain('start the request again');
  });

  it('says nothing when the engagement carries no reservation', () => {
    const overlay = buildCommerceOverlay({
      mode: 'work',
      engagement: ENGAGEMENT,
    });

    expect(overlay).not.toContain('releases at');
    expect(overlay).not.toContain('expired at');
  });
});
