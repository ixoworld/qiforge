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
  type HubActionOptionsV2,
  type HubActionOptionsV3,
} from '@ixo/action-protocol';
import {
  hubPrepareRefusal,
  prepareSubjectOf,
  type HubPrepareSubject,
} from './transfer';

export interface HubActionStatus {
  reference: ActionReferenceV1;
  ownerDid: string;
  revision: number;
  digest: string;
  reviewStatus: string;
  operationStatus: string;
  outcome: ActionOutcomeV1 | null;
}

export interface HubActionTransport {
  origin: string;
  key: string;
  fetcher?: { fetch(request: Request): Promise<Response> };
}

/**
 * The protocol version this runtime declares on every operation call
 * (capabilities, POST operations, GET status, options). Version 4 is the
 * 0.6.0 contract: version 3 plus chain transactions (`ixo.chain.tx.v1` in
 * capabilities with its `chainTx` entry, prepared through POST, receipts
 * with `steps`); options answer as at version 3 (`ixo.auth-options/3`).
 * Version 3 is the 0.5.0 contract: capabilities `transfer.limits`,
 * any-denom bank sends, v2 receipts with `denom` and `amountBaseUnits`,
 * options with the owner's tokens. Version 2 callers (runtime 0.23.0) keep
 * the 0.4.1 shapes. The envelopes stay tagged `ixo.auth-outcome/2` and
 * `ixo.auth-capabilities/2`, which `@ixo/action-protocol` parses.
 */
const HUB_PROTOCOL_VERSION = '4';
const HUB_PROTOCOL_QUERY = `version=${HUB_PROTOCOL_VERSION}`;
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

export class HubActionClient {
  private readonly origin: string;

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
    const response = await this.send(
      `/api/internal/actions/operations?${HUB_PROTOCOL_QUERY}`,
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

  async capabilities(): Promise<ActionCapabilitiesV1> {
    return parseCapabilities(
      await this.send(
        `/api/internal/actions/operations/capabilities?${HUB_PROTOCOL_QUERY}`,
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
    const query = new URLSearchParams({
      bindingId: input.bindingId,
      bindingRevision: String(input.bindingRevision),
      version: HUB_PROTOCOL_VERSION,
    });
    const options = parseActionOptions(
      await this.send(
        `/api/internal/actions/operations/options?${query.toString()}`,
      ),
    );
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
    const raw = await this.send(
      `/api/internal/actions/operations/${id}?${HUB_PROTOCOL_QUERY}`,
      undefined,
      timeoutMs,
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
      reviewStatus: value.reviewStatus,
      operationStatus: value.operationStatus,
      outcome: value.outcome == null ? null : parseOutcome(value.outcome),
    };
  }
}
