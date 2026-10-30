import {
  canonicalJson,
  parseOperation,
  type ActionCapabilitiesV1,
  type ActionOperationV1,
  type ActionReferenceV1,
  type ChainTxMessage,
  type ChainTxOperation,
} from '@ixo/action-protocol';
import type { HubActionClient } from './client';
import { HubActionRefused, type HubActionOrigin } from './store';

/**
 * A chain-transaction message as the owner object completes it: bank
 * amounts already in base units (`bankStepsInBaseUnits`), the owner's
 * identity in claims messages still to add (`chainTxOperation`).
 */
export type ChainTxHostMessage =
  | Extract<
      ChainTxMessage,
      { type: 'cosmos.bank.send' } | { type: 'ixo.token.transfer' }
    >
  | Omit<Extract<ChainTxMessage, { type: 'ixo.claims.submit' }>, 'agentDid'>
  | Omit<
      Extract<ChainTxMessage, { type: 'ixo.claims.evaluate' }>,
      'agentDid' | 'agentAddress'
    >;

/**
 * The chain transaction (`ixo.chain.tx.v1`) of the model's messages: the
 * signer is the owner's account (their DID is `did:ixo:<address>`), and
 * the owner's identity in claims messages is the signer's: `agentDid` is
 * `did:ixo:<signer>` (the DID the runtime authenticates to the Hub as) and
 * an evaluation's `agentAddress` is the signer (the chain records the
 * evaluator, and pays it, by that address; Auth Hub requires both). The
 * protocol parses the result; a field the runtime sets (signer, network,
 * chain id) is refused in fixed words, a field from the model's messages
 * in the protocol's (`Invalid messages[0].tokens[0].id`).
 */
export function chainTxOperation(input: {
  ownerDid: string;
  chainId: string;
  network: ChainTxOperation['network'];
  memo: string;
  messages: ChainTxHostMessage[];
}): ActionOperationV1 {
  // Anything but `did:ixo:<address>` leaves no usable signer, which the
  // protocol refuses below.
  const signer = input.ownerDid.startsWith('did:ixo:')
    ? input.ownerDid.slice('did:ixo:'.length)
    : '';
  const agentDid = `did:ixo:${signer}`;
  // Identity last: a stray identity field cannot survive.
  const messages: ChainTxMessage[] = input.messages.map((message) =>
    message.type === 'ixo.claims.submit'
      ? { ...message, agentDid }
      : message.type === 'ixo.claims.evaluate'
        ? { ...message, agentDid, agentAddress: signer }
        : message,
  );
  try {
    return parseOperation({
      kind: 'ixo.chain.tx.v1',
      chainId: input.chainId,
      network: input.network,
      signer,
      memo: input.memo,
      messages,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The signer (the owner's account), the network and the chain id
    // (this oracle's configuration) are the runtime's: no argument changes
    // them.
    if (/^Invalid (signer|network|chainId)$/.test(detail))
      throw new HubActionRefused(
        'refused',
        `This transaction cannot be prepared for this owner and oracle (${detail}: the runtime sets it from the owner's account and this oracle's configuration); retrying or changing the fields will not help.`,
      );
    // The protocol refusing a message built from the model's fields (an
    // address, an amount, an id) is the model's to fix.
    throw new HubActionRefused(
      'refused',
      `The transaction is incomplete (${detail}).`,
    );
  }
}

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
    if (capabilities.network !== operation.network || !capabilities.transfer)
      throw new Error("Hub transfer is outside this oracle's capability");
    // A pre-check of the per-denom cap only (the Hub enforces it, and the
    // fee is the Hub's: it simulates gas and sets it).
    const transfer = capabilities.transfer;
    const cap =
      'limits' in transfer
        ? transfer.limits.find((limit) => limit.denom === operation.denom)
            ?.maxAmountBaseUnits
        : operation.denom === 'uixo'
          ? transfer.maxAmountUixo
          : undefined;
    if (cap !== undefined && BigInt(operation.amountBaseUnits) > BigInt(cap))
      throw new HubActionRefused(
        'refused',
        `This oracle may move at most ${cap} base units of ${operation.denom} per transfer.`,
      );
  } else if (operation.kind === 'ixo.chain.tx.v1') {
    // A pre-check of what the account's capabilities list: its network,
    // the message types and the batch size. The Hub enforces each again
    // (and everything else: signer, addresses, simulation, fee).
    const chainTx = capabilities.chainTx;
    if (!chainTx || capabilities.network !== operation.network)
      throw new HubActionRefused(
        'refused',
        'Chain transactions are not available for this oracle account.',
      );
    if (operation.messages.length > chainTx.maxMessages)
      throw new HubActionRefused(
        'refused',
        `This account allows at most ${chainTx.maxMessages} messages in one transaction.`,
      );
    const unlisted = operation.messages.find(
      (message) => !chainTx.messageTypes.includes(message.type),
    );
    if (unlisted)
      throw new HubActionRefused(
        'refused',
        `This account cannot use ${unlisted.type} messages (it may use ${chainTx.messageTypes.join(', ')}).`,
      );
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
  // A retry of a key whose reservation lapsed. Auth Hub looks the key up
  // before it checks the expiry: a POST of a key it already holds (same
  // binding, expiry and operation) answers the original reference even
  // after that expiry, and only a key it does not hold is refused with 400
  // `invalid_expiry`. Here the reference recorded from the first POST is the
  // answer if there is one; without one the request is treated as over and
  // nothing is sent.
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
