import type { TurnRequest } from '../do/contracts';
import { TASK_SESSION_PREFIX } from '../tasks/scheduler';
import type { ChatLimits, DeliveryProfile } from './types';

/**
 * `OracleConfig.delivery`: per-oracle tuning of chat delivery. Matrix room
 * turns use the chat style only when `matrixChat` is `true` (off by default;
 * `MATRIX_CHAT_DELIVERY` sets it per deployment); `limits` overrides the
 * defaults below per surface (`whatsapp`, `telegram`, `slack`, `matrix`,
 * `generic`).
 */
export interface DeliveryConfig {
  matrixChat?: boolean;
  limits?: Partial<Record<string, Partial<ChatLimits>>>;
}

const GENERIC: ChatLimits = {
  bubbleTarget: 600,
  bubbleMax: 1500,
  minBubble: 60,
  maxBubbles: 3,
  maxPartsPerRun: 8,
  spillChars: 4500,
  maxListItems: 15,
  previewItems: 3,
  maxCodeLines: 40,
  tables: false,
};

/**
 * Chat first: many users read on WhatsApp alone, without a browser, so an
 * ordinary answer (several paragraphs, a list, a small comparison) stays in
 * the conversation and only a document-length step moves to an artefact.
 * Message sizes stay well under each provider's hard limit (WhatsApp and
 * Telegram 4,096 characters, Slack 12,000 per message, Matrix 64 KiB per
 * event): the gateway still enforces the hard limit, and never truncates.
 */
const DEFAULT_LIMITS: Readonly<Record<string, ChatLimits>> = {
  generic: GENERIC,
  // The generic limits are WhatsApp's: each entry below lists only what differs.
  whatsapp: { ...GENERIC },
  telegram: { ...GENERIC, bubbleTarget: 800, bubbleMax: 2000 },
  slack: {
    ...GENERIC,
    bubbleTarget: 1200,
    bubbleMax: 3000,
    spillChars: 6000,
  },
  matrix: {
    ...GENERIC,
    bubbleTarget: 1200,
    bubbleMax: 4000,
    spillChars: 8000,
  },
};

/**
 * A group room hears one short answer, not a series: one or two messages,
 * the run capped at three parts, and a step over 2,400 characters moves to
 * an artefact.
 */
const GROUP_LIMITS: Partial<ChatLimits> = {
  maxBubbles: 2,
  maxPartsPerRun: 3,
  spillChars: 2400,
};

const COUNTS = [
  'bubbleTarget',
  'bubbleMax',
  'minBubble',
  'maxBubbles',
  'maxPartsPerRun',
  'spillChars',
  'maxListItems',
  'previewItems',
  'maxCodeLines',
] as const satisfies ReadonlyArray<keyof ChatLimits>;

/**
 * The overrides an oracle may set: whole numbers of at least 1, and a
 * boolean `tables`. Anything else keeps the default, since a size of zero
 * would leave the shaper nothing to split into.
 */
function validLimits(overrides: Partial<ChatLimits> = {}): Partial<ChatLimits> {
  const out: Partial<ChatLimits> = {};
  for (const key of COUNTS) {
    const value = overrides[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1)
      out[key] = value;
  }
  if (typeof overrides.tables === 'boolean') out.tables = overrides.tables;
  return out;
}

const LABELS: Readonly<Record<string, string>> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  slack: 'Slack',
  matrix: 'a Matrix chat room',
  generic: 'a chat app',
};

/**
 * `OracleConfig.delivery` with the deployment's `MATRIX_CHAT_DELIVERY` applied:
 * the variable, when set, decides whether Matrix rooms use the chat style.
 */
export function deliveryConfigWithEnv(
  config: DeliveryConfig | undefined,
  matrixChatEnv: string | undefined,
): DeliveryConfig {
  return {
    ...config,
    matrixChat:
      matrixChatEnv === 'true' || matrixChatEnv === 'false'
        ? matrixChatEnv === 'true'
        : config?.matrixChat === true,
  };
}

/**
 * The delivery profile of one turn, from where it came in. A scheduled task
 * run streams whatever room it reports to: its result is stored and read
 * later, so it keeps the model's whole text instead of a chat rendering with
 * expiring links.
 */
export function resolveDeliveryProfile(
  turn: Pick<TurnRequest, 'client' | 'channel' | 'roomKind'> &
    Partial<Pick<TurnRequest, 'sessionId' | 'taskRunId'>>,
  config: DeliveryConfig = {},
): DeliveryProfile {
  if (turn.client === 'portal') return { kind: 'stream' };
  if (
    turn.taskRunId !== undefined ||
    turn.sessionId?.startsWith(TASK_SESSION_PREFIX)
  )
    return { kind: 'stream' };
  if (turn.client === 'matrix' && config.matrixChat !== true)
    return { kind: 'stream' };
  const surface =
    turn.client === 'matrix'
      ? 'matrix'
      : // An unknown provider id uses the generic profile. `hasOwn`: a
        // provider id such as `constructor` must not hit the prototype.
        turn.channel?.provider &&
          Object.hasOwn(DEFAULT_LIMITS, turn.channel.provider)
        ? turn.channel.provider
        : 'generic';
  const merged: ChatLimits = {
    ...(DEFAULT_LIMITS[surface] ?? GENERIC),
    ...(turn.client === 'matrix' && turn.roomKind === 'group'
      ? GROUP_LIMITS
      : {}),
    ...validLimits(config.limits?.[surface]),
  };
  // The soft target and the merge threshold never exceed the hard size.
  const bubbleTarget = Math.min(merged.bubbleTarget, merged.bubbleMax);
  const limits: ChatLimits = {
    ...merged,
    bubbleTarget,
    minBubble: Math.min(merged.minBubble, bubbleTarget),
  };
  // Rich messages only where the gateway said, on this turn, what it can show.
  const render = turn.client === 'channel' ? turn.channel?.render : undefined;
  return {
    kind: 'chat',
    surface,
    label: LABELS[surface] ?? 'a chat app',
    limits,
    ...(render ? { render } : {}),
  };
}
