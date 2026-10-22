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
} from '@ixo/action-protocol';

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

  private async send(path: string, body?: unknown): Promise<unknown> {
    const request = new Request(new URL(path, this.origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-channels-service-key': this.transport.key,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    });
    const response = await (this.transport.fetcher
      ? this.transport.fetcher.fetch(request)
      : fetch(request));
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
    const response = await this.send('/api/internal/actions/operations', {
      ...input,
      operation: parseOperation(input.operation),
    });
    if (!response || typeof response !== 'object' || !('reference' in response))
      throw new Error('Hub action response has no reference');
    return assertHubReferenceUrl(response.reference, this.origin);
  }

  async capabilities(): Promise<ActionCapabilitiesV1> {
    return parseCapabilities(
      await this.send('/api/internal/actions/operations/capabilities'),
    );
  }

  async options(input: {
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

  async status(id: string): Promise<HubActionStatus> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(id))
      throw new Error('Invalid Hub action id');
    const raw = await this.send(`/api/internal/actions/operations/${id}`);
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
