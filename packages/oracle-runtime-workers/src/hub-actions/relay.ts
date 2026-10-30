import {
  v1Receipt,
  type ActionOutcomeV1,
  type ActionReceiptV1,
} from '@ixo/action-protocol';

/**
 * A receipt as the channel gateway is handed it on a turn response: the
 * 0.4.1 bank shape (`v1Receipt`: the 0.5.0 `denom` / `amountBaseUnits`
 * dropped; the owner-facing amount line comes from hub_action_status), and
 * never a failure receipt's technical `detail`, which is for Auth Hub's
 * review page only. The owner object keeps the receipt as Auth Hub sent it.
 */
export function gatewayReceipt(
  receipt: ActionReceiptV1 | null,
): ActionReceiptV1 | null {
  const shaped = v1Receipt(receipt);
  if (shaped?.kind !== 'ixo.submission.failed.v1') return shaped;
  const { detail: _detail, ...plain } = shaped;
  return plain;
}

/** An outcome as the channel gateway is handed it (`gatewayReceipt`). */
export function gatewayOutcome(outcome: ActionOutcomeV1): ActionOutcomeV1 {
  return { ...outcome, receipt: gatewayReceipt(outcome.receipt) };
}
