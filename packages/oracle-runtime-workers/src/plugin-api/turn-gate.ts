import type {
  Logger,
  MergedConfig,
  RuntimeContext,
  UcanDelegation,
  UserKvSurface,
} from './types';

/**
 * How a turn started, as the gate sees it:
 *
 * - `portal`: `POST /turn/:sessionId` (streamed or not);
 * - `matrix`: a message in the user's direct room or one of its threads;
 * - `matrix-group`: a message in a Matrix group room;
 * - `task`: a scheduled task's run (also a Topic deliverable's run and the
 *   approved run of a `before-action` task);
 * - `channel`: a message from the IXO Channels gateway (WhatsApp);
 * - `channel-notice`: the gateway's delivery notice for a blocked file;
 * - `channel-event`: a channel event (`permission_answered`,
 *   `identity_check_updated`).
 */
export type TurnTrigger =
  | 'portal'
  | 'matrix'
  | 'matrix-group'
  | 'task'
  | 'channel'
  | 'channel-notice'
  | 'channel-event';

/**
 * What a plugin's `gateTurn` decides with. Built after authentication and
 * before anything of the turn exists: no run, no stored message, no
 * attachment read, no model call. Nothing here makes a network call unless
 * the plugin asks for it (`ucan` mints, `hasByoCredentials` reads the room
 * secrets index, through a 60 s cache).
 */
export interface TurnGateContext {
  readonly trigger: TurnTrigger;
  /**
   * The person the turn is for. `ucanDelegation` is the token the client
   * sent (Portal), else the delegation the person deposited for this oracle
   * (`raw` empty when there is none).
   */
  readonly user: {
    readonly did: string;
    readonly matrixUserId: string;
    readonly ucanDelegation: UcanDelegation;
  };
  readonly session: {
    /**
     * The session the turn runs in. Absent on a channel message that opens
     * the binding's first session (the gate runs before it is created).
     */
    readonly id?: string;
    readonly client: 'portal' | 'matrix' | 'channel';
    /** The turn's request id: the same `ctx.session.requestId` its hooks see. */
    readonly requestId: string;
    readonly roomId?: string;
    readonly roomKind?: 'direct' | 'group';
    /** Task runs: the task run's id. */
    readonly taskRunId?: string;
    /** Channel turns: the binding the turn came through. */
    readonly channel?: {
      readonly provider: string;
      readonly bindingId: string;
      readonly bindingRevision?: number;
    };
  };
  /**
   * The model the request named, when it named one: a `byo:` id asks for the
   * person's own provider. Absent → the turn runs on the person's connected
   * BYO provider when there is one (`hasByoCredentials`), else on the
   * platform's default model.
   */
  readonly model?: string;
  /** The turn carries files (they are read only after the gate allows it). */
  readonly hasAttachments: boolean;
  /** Same merged Zod-validated env as `RuntimeContext.config`. */
  readonly config: MergedConfig;
  /** The person's durable plugin rows (`RuntimeContext.kv`), on hosts that keep them. */
  readonly kv?: UserKvSurface;
  /** UCAN helpers bound to this person (`RuntimeContext.ucan`). */
  readonly ucan: RuntimeContext['ucan'];
  /**
   * Whether the person has a bring-your-own-LLM credential connected
   * (always false with `BYO_LLM_ENABLED` off). It does not say the turn will
   * use it: a request naming a platform model runs on the platform key, and
   * each call's `ModelCallReport.paidBy` is the authority.
   */
  readonly hasByoCredentials: () => Promise<boolean>;
  readonly logger: Logger;
  /** Aborted when the gate's time limit passes or the request goes away. */
  readonly signal: AbortSignal;
  /** Keep un-awaited work alive past the request (`RuntimeContext.background`). */
  readonly background?: (work: Promise<unknown>) => void;
}

/**
 * The one call to action a refusal may carry (a "Top up credits" link).
 * `url` must be `https:`; `label` 1 to 40 characters. An action that is not
 * valid is dropped from the refusal (and logged); the refusal still stands.
 */
export interface TurnRefusalAction {
  label: string;
  url: string;
}

/**
 * What a client can act on besides the message. The two documented fields
 * are shown on every surface (Portal, Matrix notice, channel reply);
 * anything else is passed to the Portal only, as is.
 */
export interface TurnRefusalDetails {
  /**
   * "Try again in about N seconds": a whole number from 1 to 86,400
   * (a fraction is rounded up). Portal answers carry it as `Retry-After`.
   * An invalid value is dropped (and logged).
   */
  retryAfterSeconds?: number;
  action?: TurnRefusalAction;
  [key: string]: unknown;
}

/**
 * Why a turn is refused. `status` is the HTTP status a Portal request is
 * answered with: `402` (payment needed), `403` (not allowed), `429` (too
 * many) or `503` (try again shortly); any other integer from 400 to 599 is
 * answered as `403` (and logged). `message` is shown to the person as is,
 * on every surface: plain text, complete on its own, no URL inside (put a
 * link in `details.action`; keep it short and actionable). `code` is a
 * machine-readable reason (`[a-z][a-z0-9_]*`, at most 64 characters),
 * stable: clients choose their presentation by it, and Matrix and channel
 * gateways throttle repeated notices per code. `details` is optional JSON,
 * at most 4 KiB serialised (`TurnRefusalDetails`).
 */
export interface TurnRefusal {
  status: number;
  message: string;
  code?: string;
  details?: TurnRefusalDetails;
}

/**
 * The JSON body of a Portal turn (`POST /messages/:sessionId`, streamed or
 * not) that a plugin's gate refused, sent with the refusal's status. It is
 * the runtime's usual error body (`statusCode`, `message`) plus the
 * refusal's `code` and `details`, the request id, and `refused: true`: the
 * marker that tells a client this answer is a gate's refusal of the turn,
 * never an authentication failure, whatever the status (a `403` with it
 * must not make a client renew its credentials). Only a gate refusal
 * carries the marker.
 */
export interface TurnRefusalBody {
  statusCode: number;
  message: string;
  code?: string;
  details?: TurnRefusalDetails;
  requestId: string;
  refused: true;
}

/**
 * Whether a turn may use the platform's own model key (the oracle's
 * OpenRouter / Nebius key and its Decision provider). `deny` lets the turn
 * run on the person's own provider (bring your own LLM) only:
 *
 * - the BYO model's "model unavailable" refusal is NOT answered by the
 *   platform model: the provider's error ends the call;
 * - roles the person's provider does not serve (vision on DeepSeek, …) get
 *   a model whose calls fail (`PlatformModelsDeniedError`);
 * - the platform-only work around the turn is skipped or refused: no
 *   session title, attachments are not read (the model is told they could
 *   not be), no capability-router or channel-routing Decision (the turn
 *   runs as with routing unavailable), `ctx.decisions` rejects with
 *   `DecisionProviderUnavailableError`;
 * - a turn that would not run on the person's provider at all (none
 *   connected, the request names a platform model, the credential could not
 *   be read) fails before any model is called.
 *
 * The restriction is stored with the run, so a queued or resumed attempt
 * keeps it. `docs/usage-metering.md` has the per-role table.
 */
export type PlatformModelsPolicy = 'allow' | 'deny';

/**
 * A gate's answer: let the turn run, or refuse it. `undefined` allows it.
 * `{ allow: true, platformModels: 'deny' }` lets it run on the person's own
 * provider only (`PlatformModelsPolicy`). Several gates compose: any
 * refusal refuses (the first in plugin order), else any `deny` denies.
 */
export type TurnGateResult =
  | { allow: true; platformModels?: PlatformModelsPolicy }
  | { refuse: TurnRefusal };

/**
 * How the runtime treats this plugin's gate when it fails: throws, answers
 * something that is not a `TurnGateResult` (an invalid refusal included), or
 * does not answer within `timeoutMs` (default 1,000 ms, at most 10,000).
 * `open` (the default) lets the turn run; `closed` refuses it with
 * `503 turn_gate_unavailable`. Either way one `[turn-gate]` line is logged.
 */
export interface TurnGatePolicy {
  onFailure?: 'open' | 'closed';
  timeoutMs?: number;
}
