import type { MergedConfig, RuntimeContext } from './types';

/**
 * Authenticated, request-local input. Deliberately exposes no model or tools.
 *
 * `config` is not the merged env: it carries the plugin's own `configSchema`
 * keys and the core settings without credentials (no LLM provider key, no
 * Matrix password or recovery phrase, no Cloudflare API token).
 *
 * The host only asks for admission on direct-room and Portal turns, never on
 * a group-room turn (a direct read is posted into the room, where every
 * member would see one user's authorized data) or a scheduled task run.
 * `roomKind` is still passed so a handler can refuse anything it would not
 * show to the whole room.
 */
export interface RequestAdmissionContext {
  readonly config: MergedConfig;
  readonly user: RuntimeContext['user'];
  readonly session: RuntimeContext['session'] & {
    /** Matrix turns: the room the turn arrived in is a direct or a group room. */
    readonly roomKind?: 'direct' | 'group';
    /** Matrix turns: the user's message event this turn answers. */
    readonly eventId?: string;
    /** Matrix turns: the thread root when the user replied inside a thread. */
    readonly threadId?: string;
  };
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
  /** Aborted when the turn is cancelled or the handler's time limit passes. */
  readonly signal: AbortSignal;
}

export type RequestAdmissionResult =
  | { kind: 'pass' }
  | { kind: 'handled'; text: string; title: string };

/** Persisted by the host, never accepted from a client. */
export type RequestDisposition =
  | { kind: 'admitting' }
  | { kind: 'agent' }
  | { kind: 'direct-read'; text: string; title: string; messageId: string };
