import {
  assertHubReferenceUrl,
  parseCapabilities,
  parseActionOptions,
  parseOperation,
  parseOutcome,
  type ActionOperationV1,
  type ActionCapabilitiesV1,
  type ActionOutcomeV1,
  type ActionReferenceV1,
  type ActionReviewView,
  type HubActionOptionsV2,
  type HubActionOptionsV3,
} from '@ixo/action-protocol';
import { HubActionRefused } from './store';
import {
  hubPrepareRefusal,
  prepareSubjectOf,
  type HubPrepareSubject,
} from './transfer';

/**
 * Auth Hub's review and operation status of an action, as
 * `@ixo/action-protocol` 0.7.0 lists them (`ActionReviewView`), or `unknown`
 * for any other value: these reach the model, so nothing but a listed
 * word is passed on.
 */
export type HubReviewStatus = ActionReviewView['reviewStatus'] | 'unknown';
export type HubOperationStatus = ActionReviewView['operationStatus'];

const REVIEW_STATUSES = [
  'prepared',
  'superseded',
  'declined',
  'expired',
  'revoked',
  'signing',
  'authorized',
] as const satisfies readonly ActionReviewView['reviewStatus'][];
const OPERATION_STATUSES = [
  'awaiting_authorization',
  'admitted',
  'submitted',
  'succeeded',
  'failed',
  'requires_review',
  'unknown',
  'not_started',
] as const satisfies readonly HubOperationStatus[];
// Every status the protocol lists is in the lists above.
type Missing<All, Listed> = Exclude<All, Listed> extends never ? true : never;
const reviewListed: Missing<
  ActionReviewView['reviewStatus'],
  (typeof REVIEW_STATUSES)[number]
> = true;
const operationListed: Missing<
  HubOperationStatus,
  (typeof OPERATION_STATUSES)[number]
> = true;
void reviewListed;
void operationListed;

/** `value` when it is a status the protocol lists, else `unknown`. */
export function hubReviewStatus(value: unknown): HubReviewStatus {
  return REVIEW_STATUSES.find((status) => status === value) ?? 'unknown';
}
export function hubOperationStatus(value: unknown): HubOperationStatus {
  return OPERATION_STATUSES.find((status) => status === value) ?? 'unknown';
}

export interface HubActionStatus {
  reference: ActionReferenceV1;
  ownerDid: string;
  revision: number;
  digest: string;
  reviewStatus: HubReviewStatus;
  operationStatus: HubOperationStatus;
  outcome: ActionOutcomeV1 | null;
}

export interface HubActionTransport {
  origin: string;
  key: string;
  fetcher?: { fetch(request: Request): Promise<Response> };
}

/**
 * The protocol version this runtime declares on every operation call
 * (capabilities, POST operations, GET status, options). Version 6 is the
 * 0.8.0 contract: version 5 plus 29 more `ixo.chain.tx.v1` message types
 * (staking, voting, retiring impact tokens, claim collections, entities and
 * identity-record links), which a 0.7.0 parser cannot read in capabilities,
 * review steps or receipts, so the Hub lists and accepts them only at level
 * 6 (`chainTxMessageTypesForLevel`); options answer as at version 3.
 * Version 5 is the 0.7.0 contract: version 4 plus the application card (`ixo.bid.submit.v1`)
 * and the claim card (`ixo.claim.submit.v1`) with their receipts
 * (`ixo.bid.submission.v1`, `ixo.claim.submission.v1`,
 * `ixo.submission.failed.v1`), which a 0.6.0 parser cannot read, so the Hub
 * lists and accepts them only at level 5; options answer as at version 3.
 * Version 4 is the 0.6.0 contract: version 3 plus chain transactions (`ixo.chain.tx.v1` in
 * capabilities with its `chainTx` entry, prepared through POST, receipts
 * with `steps`); options answer as at version 3 (`ixo.auth-options/3`).
 * Version 3 is the 0.5.0 contract: capabilities `transfer.limits`,
 * any-denom bank sends, v2 receipts with `denom` and `amountBaseUnits`,
 * options with the owner's tokens. Version 2 callers (runtime 0.23.0) keep
 * the 0.4.1 shapes. The envelopes stay tagged `ixo.auth-outcome/2` and
 * `ixo.auth-capabilities/2`, which `@ixo/action-protocol` parses.
 *
 * An Auth Hub older than version 6 checks `?version=` against its closed
 * list (1 to 5) and answers every call that declares 6 with 400
 * `invalid_request`, before anything else. This runtime then speaks
 * version 5 to it (every Hub action but the level-6 chain types keeps
 * working while Auth Hub is rolled out) and asks for 6 again after
 * `HUB_PROTOCOL_RECHECK_MS`; a Hub that refuses 5 too is told apart with
 * `HUB_UPDATE_REQUIRED`.
 */
const HUB_PROTOCOL_VERSION = '6';
/** The lowest version this runtime works at: 6 without the level-6 chain types. */
const HUB_PROTOCOL_FALLBACK_VERSION = '5';
type HubProtocolVersion =
  | typeof HUB_PROTOCOL_VERSION
  | typeof HUB_PROTOCOL_FALLBACK_VERSION;
/** How long a Hub that refused version 6 is spoken to at version 5 before 6 is tried again. */
export const HUB_PROTOCOL_RECHECK_MS = 10 * 60_000;

/**
 * What the model is told when Auth Hub refuses a read (capabilities,
 * options, status) with 400 `invalid_request`. A read carries nothing but
 * the protocol version (and, for options, the binding the runtime itself
 * checked), so that answer comes from a Hub that does not know version 6.
 * The owner object keeps every action it holds: polls and callbacks pick
 * the outcomes up once the Hub is updated.
 */
export const HUB_UPDATE_REQUIRED = `Auth Hub must be updated before this oracle can use Hub actions: it does not accept protocol version ${HUB_PROTOCOL_FALLBACK_VERSION}, the lowest this runtime works with (invalid_request). Tell the person this is not available right now; retrying or changing the fields will not help.`;
/** Every Hub call but a chain-transaction prepare. */
const HUB_TIMEOUT_MS = 10_000;
/**
 * A chain-transaction prepare: Auth Hub bounds its own chain reads and
 * simulation at about 8 s and then answers 503 `transfer_unavailable`
 * (retryable); this leaves room for that answer to arrive instead of an
 * abort here.
 */
export const HUB_CHAIN_TX_PREPARE_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A read Auth Hub refused because it does not know the declared version. */
function isUpdateRequired(error: unknown): boolean {
  return (
    error instanceof HubActionRefused && error.message === HUB_UPDATE_REQUIRED
  );
}

export class HubActionClient {
  private readonly origin: string;
  /** Until when this Hub is spoken to at version 5 (it refused 6). */
  private fallbackUntil = 0;

  constructor(private readonly transport: HubActionTransport) {
    const url = new URL(transport.origin);
    if (
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && url.hostname === 'localhost')
      ) ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !transport.key
    )
      throw new Error('Hub action transport requires a secure origin and key');
    this.origin = url.origin;
  }

  /** The protocol version the next call declares. */
  get protocolVersion(): HubProtocolVersion {
    return Date.now() < this.fallbackUntil
      ? HUB_PROTOCOL_FALLBACK_VERSION
      : HUB_PROTOCOL_VERSION;
  }

  /**
   * A read at the current version; when Auth Hub refuses version 6 as
   * unknown, the same read at version 5, remembered for
   * `HUB_PROTOCOL_RECHECK_MS`. Only reads do this: a refused read changed
   * nothing, while a prepare's 400 can be a real refusal of its operation.
   */
  private async negotiated<T>(
    read: (version: HubProtocolVersion) => Promise<T>,
  ): Promise<T> {
    const version = this.protocolVersion;
    try {
      return await read(version);
    } catch (error) {
      if (version !== HUB_PROTOCOL_VERSION || !isUpdateRequired(error))
        throw error;
      const answer = await read(HUB_PROTOCOL_FALLBACK_VERSION);
      this.fallbackUntil = Date.now() + HUB_PROTOCOL_RECHECK_MS;
      return answer;
    }
  }

  /** `subject`: what a refused prepare is called in the model's words. */
  private async send(
    path: string,
    body?: unknown,
    timeoutMs = HUB_TIMEOUT_MS,
    subject?: HubPrepareSubject,
  ): Promise<unknown> {
    const request = new Request(new URL(path, this.origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-channels-service-key': this.transport.key,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    const response = await (this.transport.fetcher
      ? this.transport.fetcher.fetch(request)
      : fetch(request));
    if (
      body !== undefined &&
      (response.status === 400 ||
        response.status === 404 ||
        response.status === 409 ||
        response.status === 429 ||
        response.status === 503)
    ) {
      // A prepare the Hub refused with a typed code (a transfer or
      // transaction that would fail, a fee above the ceiling, not enough
      // funds, a message the Hub did not accept, a missing chain
      // authorization, a busy or unavailable transfer path, an operation
      // the account may not use, a kind turned off, a protocol mismatch,
      // no account for the owner, a rate limit): the model relays it in
      // words.
      const refusal = hubPrepareRefusal(
        response.status,
        await response.json().catch(() => null),
        subject,
      );
      if (refusal) throw refusal;
    }
    if (body === undefined && response.status === 400) {
      const answer: unknown = await response.json().catch(() => null);
      if (isRecord(answer) && answer.error === 'invalid_request')
        throw new HubActionRefused(
          'refused',
          HUB_UPDATE_REQUIRED,
          undefined,
          400,
        );
    }
    if (!response.ok)
      throw new Error(`Hub action request returned ${response.status}`);
    return response.json();
  }

  async request(input: {
    bindingId: string;
    bindingRevision: number;
    requestKey: string;
    expiresAt: number;
    operation: ActionOperationV1;
  }): Promise<ActionReferenceV1> {
    // The protocol version on every operation call: the Hub answers older
    // shapes (no chain transactions, no any-denom sends, no receipt
    // amounts) without it, and stores the version per action for the
    // outcomes it pushes.
    const operation = parseOperation(input.operation);
    // The version the capabilities read before every prepare settled on.
    const response = await this.send(
      `/api/internal/actions/operations?version=${this.protocolVersion}`,
      { ...input, operation },
      operation.kind === 'ixo.chain.tx.v1'
        ? HUB_CHAIN_TX_PREPARE_TIMEOUT_MS
        : HUB_TIMEOUT_MS,
      prepareSubjectOf(operation.kind),
    );
    if (!response || typeof response !== 'object' || !('reference' in response))
      throw new Error('Hub action response has no reference');
    return assertHubReferenceUrl(response.reference, this.origin);
  }

  /** `timeoutMs`: a turn's tool list passes a short one (a slow Hub must not hold a turn). */
  async capabilities(
    timeoutMs = HUB_TIMEOUT_MS,
  ): Promise<ActionCapabilitiesV1> {
    return this.negotiated(async (version) =>
      parseCapabilities(
        await this.send(
          `/api/internal/actions/operations/capabilities?version=${version}`,
          undefined,
          timeoutMs,
        ),
      ),
    );
  }

  async options(input: {
    bindingId: string;
    bindingRevision: number;
  }): Promise<HubActionOptionsV3> {
    // Options version 3 (asked at the protocol version; version 4 answers
    // the same): version 2 plus the owner's bank tokens
    // (`transfer.tokens`), which any-token transfers are chosen from.
    const options = await this.negotiated(async (version) => {
      const query = new URLSearchParams({
        bindingId: input.bindingId,
        bindingRevision: String(input.bindingRevision),
        version,
      });
      return parseActionOptions(
        await this.send(
          `/api/internal/actions/operations/options?${query.toString()}`,
        ),
      );
    });
    if (options.version !== 'ixo.auth-options/3')
      throw new Error('Hub action options require version 3');
    return options;
  }

  /**
   * Options version 2 (connections, targets, resources; no token list),
   * for the Gmail connection check: it does not make the Hub read the
   * owner's balances.
   */
  async connectionOptions(input: {
    bindingId: string;
    bindingRevision: number;
  }): Promise<HubActionOptionsV2> {
    const query = new URLSearchParams({
      bindingId: input.bindingId,
      bindingRevision: String(input.bindingRevision),
      version: '2',
    });
    const options = parseActionOptions(
      await this.send(
        `/api/internal/actions/operations/options?${query.toString()}`,
      ),
    );
    if (options.version !== 'ixo.auth-options/2')
      throw new Error('Hub action options require version 2');
    return options;
  }

  /** `timeoutMs`: the poll path passes a short one (a slow Hub must not hold a poll). */
  async status(
    id: string,
    timeoutMs = HUB_TIMEOUT_MS,
  ): Promise<HubActionStatus> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(id))
      throw new Error('Invalid Hub action id');
    const raw = await this.negotiated((version) =>
      this.send(
        `/api/internal/actions/operations/${id}?version=${version}`,
        undefined,
        timeoutMs,
      ),
    );
    if (!isRecord(raw)) throw new Error('Invalid Hub action status');
    const value = raw;
    const reference = assertHubReferenceUrl(value.reference, this.origin);
    if (
      reference.id !== id ||
      typeof value.ownerDid !== 'string' ||
      !value.ownerDid.startsWith('did:ixo:') ||
      !Number.isSafeInteger(value.revision) ||
      typeof value.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.digest) ||
      typeof value.reviewStatus !== 'string' ||
      typeof value.operationStatus !== 'string'
    )
      throw new Error('Invalid Hub action status');
    return {
      reference,
      ownerDid: value.ownerDid,
      revision: Number(value.revision),
      digest: value.digest,
      reviewStatus: hubReviewStatus(value.reviewStatus),
      operationStatus: hubOperationStatus(value.operationStatus),
      outcome: value.outcome == null ? null : parseOutcome(value.outcome),
    };
  }
}
