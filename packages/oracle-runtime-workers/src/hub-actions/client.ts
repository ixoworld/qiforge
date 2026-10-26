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
  type HubActionOptionsV3,
} from '@ixo/action-protocol';
import { hubTransferRefusal } from './transfer';

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
 * (capabilities, POST operations, GET status, options). Version 3 is the
 * 0.5.0 contract: capabilities `transfer.limits`, any-denom bank sends, v2
 * receipts with `denom` and `amountBaseUnits`, options with the owner's
 * tokens. Version 2 callers (runtime 0.23.0) keep the 0.4.1 shapes; the
 * envelopes are still tagged `ixo.auth-outcome/2` and
 * `ixo.auth-capabilities/2`, which `@ixo/action-protocol` parses.
 */
const HUB_PROTOCOL_VERSION = '3';
const HUB_PROTOCOL_QUERY = `version=${HUB_PROTOCOL_VERSION}`;

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

  private async send(
    path: string,
    body?: unknown,
    timeoutMs = 10_000,
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
    if (response.status === 400 && body !== undefined) {
      // A transfer the Hub refused at preparation (simulation failed, fee
      // above the ceiling, not enough funds): the model relays the reason.
      const refusal = hubTransferRefusal(
        await response.json().catch(() => null),
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
    // `version=3` on every operation call: the Hub answers older shapes
    // (no any-denom sends, no receipt amounts) without it, and stores the
    // version per action for the outcomes it pushes.
    const response = await this.send(
      `/api/internal/actions/operations?${HUB_PROTOCOL_QUERY}`,
      {
        ...input,
        operation: parseOperation(input.operation),
      },
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
    // Options version 3: version 2 plus the owner's bank tokens
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

  /** `timeoutMs`: the poll path passes a short one (a slow Hub must not hold a poll). */
  async status(id: string, timeoutMs = 10_000): Promise<HubActionStatus> {
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
