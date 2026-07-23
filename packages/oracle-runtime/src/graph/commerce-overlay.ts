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

const SUPPORT_ROLE =
  'You are the front desk for this oracle: explain its services, prices, and ' +
  'contract status freely, and answer questions about how contracting works. ' +
  'Never perform the contracted service itself in this mode — when the user ' +
  'wants work done, route them to a contract instead. So: they ask what you ' +
  'offer → `list_services`; they want to start a paid job they are not ' +
  'contracted for → `show_contract`; they ask about their own contract or how ' +
  'many jobs remain → `get_contract_status`.';

/** Warn the model once the job has burned this share of its reservation window. */
const EXPIRY_WARNING_FRACTION = 0.2;

/**
 * Render the commerce prompt overlay for a routed Matrix turn. Both modes open
 * with the shared primer, then the mode framing — support is the free front
 * desk, work is a contracted service run — plus attachment-awareness and
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
    );
  } else {
    lines.push(SUPPORT_ROLE);
  }

  lines.push('', `- ${ATTACHMENT_AWARENESS}`, `- ${THREADS_NUDGE}`);

  if (commerce.mode === 'work' && commerce.engagement) {
    const deadline = expiryNotice(commerce.engagement);
    if (deadline) lines.push('', deadline);
  }

  if (commerce.gate) {
    lines.push('', gateInstruction(commerce.gate));
  }

  return lines.join('\n');
}

/**
 * The reservation deadline, surfaced only once it is close (or past). Read
 * straight off the engagement — the deadline was stamped at start precisely so
 * no chain or engine call is needed to check it mid-turn.
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
      `The payment reserved for this work expired at ${expiresAt}, so this job ` +
      'can no longer be billed. Do not keep working on it: tell the user the ' +
      'reservation window closed and that they need to start the request again.'
    );
  }

  const window = deadline - startedAt;
  if (window <= 0) return null;
  if ((deadline - now) / window > EXPIRY_WARNING_FRACTION) return null;

  return (
    `The payment reserved for this work releases at ${expiresAt} and this job ` +
    'must be delivered before then. Tell the user you are close to that ' +
    'deadline, wrap up, and call `deliver_work` with what you have.'
  );
}

/** The turn instruction for a work request that did not start an engagement. */
function gateInstruction(gate: CommerceGateFailure): string {
  const { reason, serviceId, serviceName } = gate;
  const display = serviceName ?? serviceId;

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
        'Do not do the requested work, and do not call `show_contract` — their contract is fine.'
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
      'other job ends.'
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
      'their contract.'
    );
  }

  return (
    `The user asked for "${display}" but holds no usable contract ` +
    `(reason: ${reason}). Explain this plainly, then call ` +
    `\`show_contract\` for \`${serviceId}\` so they can contract it ` +
    'from the chat.'
  );
}
