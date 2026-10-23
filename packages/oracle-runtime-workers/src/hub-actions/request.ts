import {
  canonicalJson,
  type ActionCapabilitiesV1,
  type ActionOperationV1,
  type ActionReferenceV1,
} from '@ixo/action-protocol';
import type { HubActionClient } from './client';
import { HubActionRefused, type HubActionOrigin } from './store';

export interface PreparedHubActionRequest extends HubActionOrigin {
  provider: string;
  operation: ActionOperationV1;
}

export function assertOperationEnabled(
  capabilities: ActionCapabilitiesV1,
  operation: ActionOperationV1,
  ownerDid: string,
): void {
  if (!capabilities.operations.includes(operation.kind))
    throw new Error('Hub operation is not enabled for this oracle');
  if (operation.kind === 'form.submit.v1') {
    const form = capabilities.forms.find(
      (item) => item.formId === operation.formId,
    );
    if (
      !form ||
      form.destination !== operation.destination ||
      form.declaration !== operation.declaration ||
      canonicalJson(form.fields) !==
        canonicalJson(
          operation.fields.map(
            ({ value: _value, source: _source, ...field }) => field,
          ),
        )
    )
      throw new Error('Hub form does not match the registered target');
  } else if (operation.kind === 'ixo.bank.send.v1') {
    if (
      capabilities.network !== operation.network ||
      !capabilities.transfer ||
      BigInt(operation.amountBaseUnits) >
        BigInt(capabilities.transfer.maxAmountUixo) ||
      BigInt(operation.feeBaseUnits) > BigInt(capabilities.transfer.maxFeeUixo)
    )
      throw new Error("Hub transfer is outside this oracle's capability");
  } else if (operation.kind === 'resource.read.v1') {
    if (
      operation.ownerDid !== ownerDid ||
      !capabilities.resourceOrigin ||
      new URL(operation.url).origin !== capabilities.resourceOrigin
    )
      throw new Error("Hub resource is outside this owner's capability");
  }
}

/** The host verifies the channel binding before invoking this transport. */
export async function prepareHubAction(
  client: Pick<HubActionClient, 'capabilities' | 'request'>,
  store: {
    reserve(
      origin: HubActionOrigin,
      operation: ActionOperationV1,
      proposedExpiry: number,
    ): Promise<number>;
    record(
      origin: HubActionOrigin,
      reference: ActionReferenceV1,
    ): Promise<ActionReferenceV1>;
    byRequestKey?(requestKey: string): Promise<ActionReferenceV1 | null>;
  },
  input: PreparedHubActionRequest,
  nowMs = Date.now(),
): Promise<ActionReferenceV1> {
  const capabilities = await client.capabilities();
  assertOperationEnabled(capabilities, input.operation, input.ownerDid);
  const expiresAt = await store.reserve(
    input,
    input.operation,
    Math.floor(nowMs / 1000) + 15 * 60,
  );
  // A retry of a key whose reservation lapsed: the Hub refuses a past
  // expiry before its idempotency lookup, so a POST could never succeed.
  // The recorded reference (the first POST's) is the answer if there is
  // one; otherwise the request is over.
  if (expiresAt <= Math.floor(nowMs / 1000)) {
    const recorded = await store.byRequestKey?.(input.requestKey);
    if (recorded) return recorded;
    throw new HubActionRefused(
      'expired',
      'This review request expired before it reached Auth Hub; ask the user to confirm again.',
    );
  }
  const reference = await client.request({
    bindingId: input.bindingId,
    bindingRevision: input.bindingRevision,
    requestKey: input.requestKey,
    expiresAt,
    operation: input.operation,
  });
  if (
    reference.accountId !== capabilities.accountId ||
    reference.bindingId !== input.bindingId ||
    reference.bindingRevision !== input.bindingRevision
  )
    throw new Error(
      'Hub action reference does not match the authenticated account',
    );
  return store.record(input, reference);
}
