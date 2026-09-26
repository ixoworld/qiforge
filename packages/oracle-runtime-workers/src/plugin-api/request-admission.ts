import type { MergedConfig, RuntimeContext } from './types';

/** Authenticated, request-local input. Deliberately exposes no model or tools. */
export interface RequestAdmissionContext {
  readonly config: MergedConfig;
  readonly user: RuntimeContext['user'];
  readonly session: RuntimeContext['session'];
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
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
