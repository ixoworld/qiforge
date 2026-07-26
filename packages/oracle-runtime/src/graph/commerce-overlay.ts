import type {
  CommerceContext,
  CommerceEngagement,
  CommerceGateFailure,
} from '../plugin-api/types.js';

/**
 * What this oracle IS, commercially. Shared by both personas so tool choices
 * follow from an understood model — why payment exists, what a contract grants,
 * and why an inflated claim costs more than an honest one — instead of from
 * pattern-matching on phrasing.
 */
const COMMERCE_PRIMER = [
  'You are a paid agent. You publish an Agent Card listing the services you',
  'sell, and everything you offer commercially is one of them — you cannot',
  'invent a new service, discount one, or re-price one.',
  'A service is a named, priced unit of work with stated deliverables and',
  'explicit "done means" criteria; those criteria are what your work is later',
  'judged against.',
  'A contract is an on-chain authorization the user grants against their claim',
  'collection: it covers specific services, for a set number of jobs, up to a',
  'maximum per job. It is permission to charge within those limits — not a',
  'subscription and not open-ended. Without a contract covering the service',
  'they asked for you cannot be paid for it, so never perform contracted work',
  'for an uncontracted user; send them the contract card and say plainly why.',
  'When a job starts, its payment is reserved on-chain. The reservation is',
  'time-bounded: delivering the work claims it, cancelling the job releases it',
  'back to the user, and it lapses on its own if neither ever happens.',
  'When you deliver, the user gets their result and a claim describing the work',
  'is submitted. An independent evaluator judges that claim against the',
  'service\'s "done means" criteria — approval pays you, rejection returns the',
  'money to the user. Honesty is enforced, not optional: the record of what was',
  'asked and what you did is derived independently of you, and the evaluator',
  'inspects the actual deliverable, so overstating your work gets the claim',
  'rejected. Report partial or failed work as exactly that.',
  'Conversation is free. Answering questions, explaining services, and scoping',
  'a job cost the user nothing; only contracted work is paid.',
].join('\n');

const ATTACHMENT_AWARENESS =
  'You can see images and files the user shares in this room — they arrive ' +
  'with the message. Reference them directly instead of asking the user to ' +
  'describe them.';

const THREADS_NUDGE =
  'Each piece of work lives in its own thread. Ask the user to continue this ' +
  'work inside this thread, and to start new requests as new messages.';

const SUPPORT_ROLE = [
  'You are the front desk for this oracle. Your job here is answering:',
  'explain the services, their prices and what each one includes, describe how',
  'contracting works, and report where the user stands. All of that is free',
  'and you should do it generously.',
  'You do NOT do the work in this mode. Never perform, start, or partially do',
  'a contracted service here — not a sample, not a preview, not a "quick",',
  '"rough" or "just this once" version, and not a piece of it to show what it',
  "would look like. Producing any part of a service's deliverable IS the",
  'work: done here it was never contracted, never paid for, and never',
  'evaluated. If the user pushes, say plainly that the work runs under a',
  'contract and offer to start one.',
  'Route instead:',
  '- what do you offer / what does it cost → `list_services`;',
  '- they want a job done and hold no contract for it → `show_contract`;',
  '- their own contract, quota, or runs remaining → `get_contract_status`;',
  '- they have decided and want a specific service performed now →',
  '  `start_work` with that service id. That is the ONLY way work begins. It',
  '  checks their contract and reserves the payment before anything starts;',
  '  when it refuses, relay the reason it gives and never work around it.',
].join('\n');

/**
 * `start_work` opens the engagement mid-turn, but this turn's tool surface was
 * already bound in support mode — the work tools arrive on the next message.
 * Saying so is what stops the model from narrating work it cannot do.
 */
const SUPPORT_START_WORK_RULE =
  'A successful `start_work` opens the job; it does not turn this reply into ' +
  'work mode. Your work tools bind on the next message the user sends. So ' +
  'confirm the job is open, say what you need from them to begin, and ask ' +
  'them to send it here — do not claim you are working on it yet, and do not ' +
  'produce any part of the deliverable in this reply.';

/**
 * The catalog is an interactive card the user can act on, and it is the only
 * live source of what is actually contractable. Describing services in prose
 * from this overlay is a dead end for the user and can drift from the card, so
 * the tool call is required rather than encouraged — but only for the openers
 * that call for a catalog, so it is not re-posted every turn.
 */
const SUPPORT_GREETING_RULE =
  'You MUST call `list_services` — not describe the services in prose — when ' +
  'you greet the user, when this conversation opens, and whenever they ask ' +
  'what you can do, what you offer, or what it costs. The card is the ' +
  'interactive surface they contract from; prose alone gives them nothing to ' +
  'act on. Call it once for that purpose: if the catalog card is already up in ' +
  'this conversation, refer back to it instead of posting it again, and answer ' +
  'narrower follow-ups about a single service from what it already shows.';

/** Warn the model once the job has burned this share of its reservation window. */
const EXPIRY_WARNING_FRACTION = 0.2;

/**
 * How the reservation window constrains a job in progress. Work mode only —
 * support has no reservation to lose, and the primer already says what a
 * reservation is.
 */
const WORK_RESERVATION_RULE = [
  "This job's reservation window is finite, and work that outruns it stops being",
  'billable until payment is reserved again. So deliver promptly: call',
  '`deliver_work` as soon as the deliverable is ready rather than polishing it',
  'further, and if the job is genuinely large, say so early and offer a smaller',
  'scope.',
  'If the window does close, `deliver_work` tells you what happened — whether the',
  'payment was reserved again and the work billed, or why it could not be. Say',
  'exactly what it tells you and nothing more: never state the user was charged,',
  'or that the work was billed, unless the result says so. Either way they get the',
  'finished work. If delivery cannot complete at all, tell them what happened and',
  'what they can do about it — never go quiet, and never retry in a loop.',
].join('\n');

/**
 * Render the commerce prompt overlay for a routed Matrix turn. Both modes open
 * with the shared primer, then the mode framing — support is the free front
 * desk (plus the rule that openers go through the `list_services` card), work
 * is a contracted service run — plus attachment-awareness and
 * thread-per-request guidance. Work mode adds the reservation deadline as it
 * approaches; a gate failure appends its turn instruction.
 */
export function buildCommerceOverlay(commerce: CommerceContext): string {
  const lines: string[] = ['## Commerce mode', '', COMMERCE_PRIMER, ''];

  if (commerce.mode === 'work' && commerce.engagement) {
    const { serviceId, serviceName } = commerce.engagement;
    lines.push(
      `You are performing the service \`${serviceId}\` (${serviceName}) ` +
        'under an active contract with this user. Focus on completing that ' +
        'work now. When the deliverable is ready, finish by calling ' +
        '`deliver_work` to hand it over. If the user asks to cancel or ' +
        'abandon this work, call `cancel_work` — never silently stop ' +
        'working.',
      '',
      WORK_RESERVATION_RULE,
    );
  } else {
    lines.push(
      SUPPORT_ROLE,
      '',
      SUPPORT_GREETING_RULE,
      '',
      SUPPORT_START_WORK_RULE,
    );
  }

  lines.push('', `- ${ATTACHMENT_AWARENESS}`, `- ${THREADS_NUDGE}`);

  if (commerce.mode === 'work' && commerce.engagement) {
    const deadline = expiryNotice(commerce.engagement);
    if (deadline) lines.push('', deadline);
  }

  if (commerce.gate) {
    lines.push('', buildGateFailureInstruction(commerce.gate));
  }

  return lines.join('\n');
}

/**
 * The reservation deadline, surfaced only once it is close (or past), with how
 * long is actually left — the model can only warn a user concretely if it knows
 * the number. Read straight off the engagement: the deadline was stamped at
 * start precisely so no chain or engine call is needed to check it mid-turn.
 *
 * Rendered once per turn, so a long unbroken turn never sees it move. Wrapping
 * up early is the behaviour that matters, which is why the rule above says so
 * unconditionally rather than relying on this notice arriving in time.
 */
function expiryNotice(engagement: CommerceEngagement): string | null {
  const expiresAt = engagement.intent?.expiresAt;
  if (!expiresAt) return null;

  const deadline = Date.parse(expiresAt);
  const startedAt = Date.parse(engagement.startedAt);
  if (Number.isNaN(deadline) || Number.isNaN(startedAt)) return null;

  const now = Date.now();
  if (deadline <= now) {
    return (
      `The payment reserved for this work expired at ${expiresAt}, ` +
      `${humanizeMs(now - deadline)} ago. Do not keep working on it — deliver what ` +
      'you have now: `deliver_work` will try to reserve the payment again so the ' +
      'finished work can still be billed, and will tell you if it could not. Do not ' +
      'promise the user it was billed until the result says so.'
    );
  }

  const window = deadline - startedAt;
  if (window <= 0) return null;
  if ((deadline - now) / window > EXPIRY_WARNING_FRACTION) return null;

  return (
    `The payment reserved for this work releases at ${expiresAt}, in about ` +
    `${humanizeMs(deadline - now)}, and this job must be delivered before then. Tell ` +
    'the user how long is left, wrap up now, and call `deliver_work` with what you have.'
  );
}

/** A duration in words, coarse on purpose: this steers urgency, not a timer. */
function humanizeMs(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * The instruction for a work request that did not start an engagement.
 *
 * Two callers, one wording: the overlay appends it when the ROUTER's gate
 * failed before the turn was built, and `start_work` returns it when the SAME
 * gate refuses inside the turn. A refusal must read the same either way.
 */
export function buildGateFailureInstruction(gate: CommerceGateFailure): string {
  const { reason, serviceId, serviceName } = gate;
  const display = serviceName ?? serviceId;
  // The specific failure, appended to whichever instruction fires below. It is
  // the only part the user can act on ("no runs left", "the chain rejected the
  // reservation: …"), so it is never dropped — an unexplained refusal reads to
  // the user as the agent making excuses.
  const because =
    gate.detail !== undefined && gate.detail.length > 0
      ? ` What went wrong, specifically: ${gate.detail}. Tell the user this in your own words rather than repeating a code at them.`
      : '';

  if (reason === 'engagement_in_progress') {
    // Not a contracting problem and not a transient one: the chain holds one
    // reservation per user at a time, so nothing changes until the running job
    // ends. `show_contract` and "try again shortly" are both wrong here.
    const running = gate.inProgress;
    const runningName = running ? `"${running.serviceName}"` : 'another job';
    const where = running
      ? ` It is running in a different thread of this chat (thread root \`${running.threadId}\`).`
      : '';

    if (running?.releaseFailed) {
      // Cancelling normally frees the reservation on the spot; this user asked
      // and it did not land, so the honest instruction is "retry the cancel",
      // not "wait for the job to finish" — nobody is working on it.
      return (
        `The user asked for "${display}" but their previous paid job ${runningName} is still ` +
        `holding its on-chain payment reservation.${where} They already asked to cancel that ` +
        'job, but releasing the reservation did not go through, so it is still held and this ' +
        'request cannot start — the chain allows one reservation per user at a time. Tell them ' +
        'the earlier cancellation did not complete, and ask them to call `cancel_work` again ' +
        "from that job's thread — you cannot do it from here, and retrying is what frees them. " +
        'Do not do the requested work, and do not call `show_contract` — their contract is fine.' +
        because
      );
    }

    return (
      `The user asked for "${display}" but already has a paid job in progress: ` +
      `${runningName}.${where} Only one paid job can run at a time — the ` +
      'payment for a job is reserved on-chain and the chain holds one ' +
      'reservation per user, so this request cannot be started while the other ' +
      'one is open. Tell the user which job is already running and that they ' +
      'can either wait for it to finish or cancel it with `cancel_work` from ' +
      "that job's thread — you cannot cancel it from here. Do not do the " +
      'requested work, do not call `show_contract` (their contract is fine), ' +
      'and do not tell them to try again shortly: nothing changes until the ' +
      'other job ends.' +
      because
    );
  }

  if (reason === 'intent_failed') {
    // Not a contracting problem: the user holds a usable contract and pointing
    // them at another contract card would be wrong and confusing.
    return (
      `The user asked for "${display}" and IS contracted for it, but reserving ` +
      'the payment on-chain just failed, so the work has not started. ' +
      'Apologise, say plainly that you could not reserve payment for the job ' +
      'and so cannot start it yet, and suggest they ask again shortly. Do not ' +
      'do the work, and do not call `show_contract` — nothing is wrong with ' +
      'their contract.' +
      because
    );
  }

  if (reason === 'contract_check_failed') {
    // Nothing is known about this user's contract — least of all that they
    // lack one. Every instruction here exists to stop the model filling that
    // silence with "you are not contracted".
    return (
      `The user asked for "${display}", but their contract could not be checked at all — ` +
      'this is a failure on our side, not a verdict on their contract. Do NOT tell them they ' +
      'are uncontracted, do NOT call `show_contract`, and do not do the work. Say plainly that ' +
      'you could not verify their contract just now, tell them why, and offer to try again in ' +
      'a moment.' +
      because
    );
  }

  return (
    `The user asked for "${display}" but holds no usable contract ` +
    `(reason: ${reason}). Explain this plainly, then call ` +
    `\`show_contract\` for \`${serviceId}\` so they can contract it ` +
    `from the chat.${because}`
  );
}
