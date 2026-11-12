/**
 * Events the channel gateway sends in an event turn
 * (`src/channels/contract.ts`): a permission card's answer from the Auth
 * Hub, or a change of an identity check at Self. They carry ids and a fixed
 * status only, never text from the Hub or Self. An event is a claim, not
 * proof: a plugin that acts on one reads the card at the Auth Hub, or the
 * link at Self, first.
 */
export const PERMISSION_EVENT_STATUSES = [
  'allowed',
  'not_allowed',
  'expired',
] as const;
export type PermissionEventStatus = (typeof PERMISSION_EVENT_STATUSES)[number];

export const IDENTITY_CHECK_EVENT_STATUSES = [
  'in_review',
  'passed',
  'failed',
] as const;
export type IdentityCheckEventStatus =
  (typeof IDENTITY_CHECK_EVENT_STATUSES)[number];

/** The person answered a permission card in their wallet. */
export interface PermissionAnsweredEvent {
  kind: 'permission_answered';
  /** The Hub card id the oracle got when it asked for the card. */
  permissionId: string;
  status: PermissionEventStatus;
  /** The event turn's request id (`permission:<permissionId>:<status>`). */
  requestId: string;
}

/** An identity check at Self went into review, passed or failed. */
export interface IdentityCheckUpdatedEvent {
  kind: 'identity_check_updated';
  /** Self's link id the oracle got when it created the link. */
  linkId: string;
  status: IdentityCheckEventStatus;
  /** The event turn's request id (`identity:<linkId>:<status>`). */
  requestId: string;
}

export type OracleChannelEvent =
  | PermissionAnsweredEvent
  | IdentityCheckUpdatedEvent;

/**
 * What a plugin makes of an event (`handleChannelEvent`).
 *
 * - `pass`: not this plugin's card or link; the next plugin is asked.
 * - `ignore`: this plugin's, and nothing is said (a duplicate, something
 *   the person already learned in the chat, or the Hub or Self does not
 *   confirm it). The turn ends with an empty reply.
 * - `reply`: `text` is sent as it is, without the model.
 * - `agent`: the model runs with `note` where the person's message would be.
 *
 * `note` is the plugin's fixed text for the model (never shown as the
 * person's words, never sent to them): for `reply` it records what was
 * said, for `agent` it says what to do. Both are the plugin's own wording,
 * never text from the event, the Hub or Self.
 */
export type ChannelEventResult =
  | { kind: 'pass' }
  | { kind: 'ignore' }
  | { kind: 'reply'; text: string; note: string }
  | { kind: 'agent'; note: string };

/** The longest `text` or `note` a plugin may return. */
export const MAX_CHANNEL_EVENT_TEXT = 4_000;
