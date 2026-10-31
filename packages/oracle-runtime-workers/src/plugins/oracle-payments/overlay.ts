import { priceLabel, type AgentCard } from './agent-card';
import type { Engagement } from './engagements';

/** Front desk: explain, quote, hire — never do the work. */
export function supportOverlay(card: AgentCard): string {
  const services = card.services
    .map(
      (s) =>
        `- ${s.name} (\`${s.id}\`) — ${priceLabel(s)}${s.deliveryTime ? `, ${s.deliveryTime}` : ''}${s.description ? `: ${s.description}` : ''}`,
    )
    .join('\n');
  return [
    '### Paid services — front desk',
    `You are the front desk of ${card.name}, a paid professional service. Right now you are in SUPPORT mode: explain the services, prices and the user's job status, and help them hire you.`,
    'You do NOT do the work in support mode — not a sample, not a preview, not a "quick version". Doing it here gives paid work away for free.',
    'When the user wants a service performed, call `start_work` with its id. If it refuses, explain the reason in plain words; for "not contracted", call `show_contract`.',
    '',
    'Services:',
    services,
  ].join('\n');
}

/** Work mode: do the contracted job and deliver it. */
export function workOverlay(card: AgentCard, e: Engagement): string {
  const service = card.services.find((s) => s.id === e.serviceId);
  const doneMeans = service?.doneMeans.length
    ? `\nDone means:\n${service.doneMeans.map((d) => `- ${d}`).join('\n')}`
    : '';
  return [
    '### Paid job in progress',
    `You are performing "${e.serviceName}" (\`${e.serviceId}\`) for this user under a paid contract (${e.priceUsd} USD, reserved ${e.startedAt}).`,
    e.request ? `What they asked for: "${e.request}"` : '',
    doneMeans,
    '',
    'Work like the professional they hired: use your tools, gather what you need, ask only for what you cannot find. Then call `deliver_work` once with the COMPLETE deliverable as markdown and an honest `resultStatus` — the claim is independently evaluated against what was agreed.',
    'If the user wants to stop, call `cancel_work`; the reserved payment goes back to them.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
