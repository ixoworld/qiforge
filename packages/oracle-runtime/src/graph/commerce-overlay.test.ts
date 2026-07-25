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
    expect(overlay).toContain('images and files the user shares');
    expect(overlay).toContain('its own thread');
    // The support tool set follows from the primer.
    expect(overlay).toContain('`list_services`');
    expect(overlay).toContain('`show_contract`');
    expect(overlay).toContain('`get_contract_status`');
    // Work tools are not exposed in support mode — do not advertise them.
    expect(overlay).not.toContain('deliver_work');
  });

  it('forbids doing the work in support mode — including a sample or a preview', () => {
    // The loose version of this ("never perform the service") left the model
    // room to produce "just a quick version" of a deliverable, which is the
    // work, unpaid and unevaluated.
    const overlay = buildCommerceOverlay({ mode: 'support' });

    expect(overlay).toContain('You do NOT do the work in this mode');
    expect(overlay).toMatch(/not a sample, not a preview/);
    expect(overlay).toMatch(
      /Producing any part of a service's deliverable IS the\s+work/,
    );

    // The work persona is the opposite instruction — doing the work is the
    // whole point there, and this prohibition must not leak into it.
    const work = buildCommerceOverlay({ mode: 'work', engagement: ENGAGEMENT });
    expect(work).not.toContain('You do NOT do the work in this mode');
    expect(work).not.toContain('not a sample, not a preview');
    expect(work).toContain('Focus on completing that work now');
  });

  it('routes a "do it now" through start_work and warns the work starts next message', () => {
    const overlay = buildCommerceOverlay({ mode: 'support' });

    expect(overlay).toContain('`start_work`');
    expect(overlay).toContain('ONLY way work begins');
    // The tool surface for THIS turn was already bound in support mode, so the
    // model must not narrate work it has no tools for.
    expect(overlay).toContain('does not turn this reply into work mode');
    expect(overlay).toContain('bind on the next message');

    // Work mode is already there — nothing to transition into.
    const work = buildCommerceOverlay({ mode: 'work', engagement: ENGAGEMENT });
    expect(work).not.toContain('start_work');
  });

  it('requires the list_services card for greetings and "what can you do" — support mode only', () => {
    const support = buildCommerceOverlay({ mode: 'support' });

    // A suggestion lets the model answer from the primer in prose and never
    // post the card the user actually contracts from, so this is binding.
    expect(support).toContain('MUST call `list_services`');
    expect(support).toContain('not describe the services in prose');
    expect(support).toMatch(/greet the user/);
    // ...but not on every turn: a card already up is referred back to.
    expect(support).toContain('already up in this conversation');

    // The work persona is mid-job; it has no `list_services` and must not be
    // told to greet with a catalog.
    const work = buildCommerceOverlay({ mode: 'work', engagement: ENGAGEMENT });
    expect(work).not.toContain('MUST call `list_services`');
    expect(work).not.toContain('list_services');
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

  it('warns to wrap up once the window is nearly spent, with how long is left', () => {
    const engagement = withIntentWindow(10 * HOUR_MS, HOUR_MS);
    const overlay = buildCommerceOverlay({ mode: 'work', engagement });

    // The concrete number is the point: "soon" gives the user nothing.
    expect(overlay).toContain(
      `releases at ${engagement.intent!.expiresAt!}, in about 1 hour,`,
    );
    expect(overlay).toContain('Tell the user how long is left');
    expect(overlay).toContain('`deliver_work`');
  });

  it('sends the model to deliver_work once the window has passed, not to give up', () => {
    // The delivery lane re-reserves and settles, so "start the request again"
    // would be wrong — and telling the user they were billed would be a guess.
    const engagement = withIntentWindow(10 * HOUR_MS, -HOUR_MS);
    const overlay = buildCommerceOverlay({ mode: 'work', engagement });

    expect(overlay).toContain(
      `expired at ${engagement.intent!.expiresAt!}, 1 hour ago`,
    );
    expect(overlay).toContain('Do not keep working');
    expect(overlay).toContain('deliver what you have now');
    expect(overlay).toContain('reserve the payment again');
    expect(overlay).toContain('Do not promise the user it was billed');
  });

  it('teaches the reservation window in work mode only', () => {
    const work = buildCommerceOverlay({ mode: 'work', engagement: ENGAGEMENT });

    expect(work).toContain('reservation window is finite');
    expect(work).toContain(
      '`deliver_work` as soon as the deliverable is ready',
    );
    expect(work).toContain('never state the user was charged');
    expect(work).toContain('never go quiet, and never retry in a loop');

    // Support has no reservation to lose, and the primer already covers what a
    // reservation is — repeating it here would be prompt bloat.
    const support = buildCommerceOverlay({ mode: 'support' });
    expect(support).not.toContain('reservation window is finite');
    expect(support).not.toContain('as soon as the deliverable is ready');
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
