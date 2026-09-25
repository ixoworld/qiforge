import type { TurnRequest } from '../do/contracts';
import type { ChatLimits, DeliveryProfile } from './types';

/**
 * `OracleConfig.delivery`: per-oracle tuning of chat delivery. Matrix room
 * turns use the chat style unless `matrixChat` is `false`; `limits`
 * overrides the defaults below per surface (`whatsapp`, `telegram`,
 * `slack`, `matrix`, `generic`).
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
  maxPartsPerRun: 5,
  spillChars: 1800,
  maxListItems: 7,
  previewItems: 3,
  maxCodeLines: 12,
  tables: false,
};

/**
 * Well under each provider's hard limit (WhatsApp and Telegram 4,096
 * characters, Slack 12,000 per message, Matrix 64 KiB per event): the
 * gateway still enforces the hard limit, and never truncates.
 */
const DEFAULT_LIMITS: Readonly<Record<string, ChatLimits>> = {
  generic: GENERIC,
  whatsapp: { ...GENERIC, maxBubbles: 4, maxPartsPerRun: 6 },
  telegram: {
    ...GENERIC,
    bubbleTarget: 800,
    bubbleMax: 2000,
    maxBubbles: 4,
    maxPartsPerRun: 6,
    spillChars: 2400,
  },
  slack: {
    ...GENERIC,
    bubbleTarget: 1200,
    bubbleMax: 3000,
    spillChars: 3500,
  },
  matrix: {
    ...GENERIC,
    bubbleTarget: 1200,
    bubbleMax: 4000,
    spillChars: 4000,
  },
};

/** A group room hears one short answer, not a series. */
const GROUP_LIMITS: Partial<ChatLimits> = { maxBubbles: 2, maxPartsPerRun: 3 };

const LABELS: Readonly<Record<string, string>> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  slack: 'Slack',
  matrix: 'a Matrix chat room',
  generic: 'a chat app',
};

/** The delivery profile of one turn, from where it came in. */
export function resolveDeliveryProfile(
  turn: Pick<TurnRequest, 'client' | 'channel' | 'roomKind'>,
  config: DeliveryConfig = {},
): DeliveryProfile {
  if (turn.client === 'portal') return { kind: 'stream' };
  if (turn.client === 'matrix' && config.matrixChat === false)
    return { kind: 'stream' };
  const surface =
    turn.client === 'matrix'
      ? 'matrix'
      : turn.channel?.provider && DEFAULT_LIMITS[turn.channel.provider]
        ? turn.channel.provider
        : 'generic';
  const limits: ChatLimits = {
    ...(DEFAULT_LIMITS[surface] ?? GENERIC),
    ...(turn.client === 'matrix' && turn.roomKind === 'group'
      ? GROUP_LIMITS
      : {}),
    ...config.limits?.[surface],
  };
  return {
    kind: 'chat',
    surface,
    label: LABELS[surface] ?? 'a chat app',
    limits,
  };
}
