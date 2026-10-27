import { describe, expect, it } from 'vitest';
import type { ActionReceiptV1 } from '@ixo/action-protocol';
import {
  bankReceiptSummary,
  describeAmount,
  fromBaseUnits,
  hubPrepareRefusal,
  toBaseUnits,
  type TransferToken,
} from './transfer';

const IXO: TransferToken = {
  denom: 'uixo',
  symbol: 'IXO',
  decimals: 6,
  verified: true,
};
const USDC: TransferToken = {
  denom: `ibc/${'A'.repeat(64)}`,
  symbol: 'USDC',
  decimals: 6,
  verified: true,
};
// Anyone can name a factory token "USDC": unverified, so decimals 0.
const FAKE: TransferToken = {
  denom: 'factory/ixo1creator/usdc',
  symbol: 'USDC',
  decimals: 0,
  verified: false,
};

function bankReceipt(
  fields: Partial<Extract<ActionReceiptV1, { kind: 'ixo.bank.send.v1' }>>,
): ActionReceiptV1 {
  return {
    kind: 'ixo.bank.send.v1',
    actionId: 'A'.repeat(32),
    revision: 1,
    digest: 'a'.repeat(64),
    chainId: 'ixo-5',
    txHash: 'f'.repeat(64),
    height: 100,
    code: 0,
    ...fields,
  };
}

describe('any-token transfer amounts', () => {
  it('converts display amounts to base units exactly, with no float math', () => {
    expect(toBaseUnits('1', 6)).toBe(1_000_000n);
    expect(toBaseUnits('1.25', 6)).toBe(1_250_000n);
    expect(toBaseUnits('0.000001', 6)).toBe(1n);
    expect(toBaseUnits('123456789012345678901234567890', 18)).toBe(
      123456789012345678901234567890n * 10n ** 18n,
    );
    expect(toBaseUnits('7', 0)).toBe(7n);
    // Trailing zeros carry no value.
    expect(toBaseUnits('1.50', 1)).toBe(15n);
    expect(toBaseUnits('7.000', 0)).toBe(7n);
  });

  it('refuses too many decimals, zero and anything but a plain decimal', () => {
    expect(() => toBaseUnits('1.0000001', 6)).toThrow('at most 6 digits');
    expect(() => toBaseUnits('1.5', 0)).toThrow('whole base units');
    expect(() => toBaseUnits('0', 6)).toThrow('above zero');
    expect(() => toBaseUnits('0.000', 6)).toThrow('above zero');
    for (const bad of [
      '',
      '-1',
      '1e6',
      '01',
      '1.',
      '.5',
      '1,5',
      'NaN',
      ' 1 ',
      '１',
    ])
      expect(() => toBaseUnits(bad, 6)).toThrow('plain decimal');
    expect(() => toBaseUnits('9'.repeat(81), 0)).toThrow('plain decimal');
  });

  it('formats base units back without rounding or trailing zeros', () => {
    expect(fromBaseUnits('1250000', 6)).toBe('1.25');
    expect(fromBaseUnits('1000000', 6)).toBe('1');
    expect(fromBaseUnits('1', 6)).toBe('0.000001');
    expect(fromBaseUnits(42n, 0)).toBe('42');
  });

  it('names the full denom for everything but IXO and marks unverified tokens', () => {
    expect(describeAmount('1250000', IXO)).toBe('1.25 IXO');
    expect(describeAmount('1250000', USDC)).toBe(`1.25 USDC (${USDC.denom})`);
    expect(describeAmount('1250000', FAKE)).toBe(
      '1250000 base units of factory/ixo1creator/usdc (unverified token)',
    );
  });
});

describe('bank receipt summary', () => {
  it('reads the amount from the stored token when the denom matches', () => {
    expect(
      bankReceiptSummary(
        bankReceipt({ denom: USDC.denom, amountBaseUnits: '2500000' }),
        USDC,
      ),
    ).toBe(
      `Transfer of 2.5 USDC (${USDC.denom}) confirmed on chain. Transaction ${'f'.repeat(64)}, block 100.`,
    );
  });

  it('reads uixo as IXO without a stored token', () => {
    expect(
      bankReceiptSummary(
        bankReceipt({ denom: 'uixo', amountBaseUnits: '1500000' }),
        null,
      ),
    ).toBe(
      `Transfer of 1.5 IXO confirmed on chain. Transaction ${'f'.repeat(64)}, block 100.`,
    );
  });

  it('falls back to base units and the full denom without a matching token', () => {
    expect(
      bankReceiptSummary(
        bankReceipt({ denom: USDC.denom, amountBaseUnits: '2500000', code: 5 }),
        IXO,
      ),
    ).toBe(
      `Transfer of 2500000 base units of ${USDC.denom} (unverified token) failed on chain. Transaction ${'f'.repeat(64)}, block 100.`,
    );
  });

  it('says when a transfer was not included, with the reason', () => {
    expect(
      bankReceiptSummary(
        bankReceipt({
          height: null,
          code: null,
          reason: 'expired_not_included',
          denom: 'uixo',
          amountBaseUnits: '5',
        }),
        IXO,
      ),
    ).toBe(
      `Transfer of 0.000005 IXO was not included on chain (expired not included). Transaction ${'f'.repeat(64)}.`,
    );
  });

  it('describes a v1 receipt without amounts and ignores other receipts', () => {
    expect(bankReceiptSummary(bankReceipt({}), null)).toBe(
      `Transfer confirmed on chain. Transaction ${'f'.repeat(64)}, block 100.`,
    );
    expect(bankReceiptSummary(null, null)).toBeNull();
    expect(
      bankReceiptSummary(
        {
          kind: 'form.submission.v1',
          actionId: 'A'.repeat(32),
          revision: 1,
          digest: 'a'.repeat(64),
          valuesDigest: 'b'.repeat(64),
          submittedAt: 1770000000000,
          submissionId: 'submission',
        },
        null,
      ),
    ).toBeNull();
  });
});

describe('Hub prepare refusals', () => {
  it('maps the three transfer preparation errors (400) and keeps a short reason', () => {
    expect(
      hubPrepareRefusal(400, { error: 'insufficient_funds' }),
    ).toMatchObject({
      name: 'HubActionRefused',
      kind: 'refused',
      message:
        'The account does not hold enough to cover this transfer and its network fee.',
    });
    expect(
      hubPrepareRefusal(400, {
        error: 'simulation_failed',
        reason: 'x'.repeat(500),
      })?.message,
    ).toBe(
      `Auth Hub simulated this transfer and it would fail on chain: ${'x'.repeat(200)}.`,
    );
    expect(
      hubPrepareRefusal(400, { error: 'fee_above_ceiling', reason: '  ' })
        ?.message,
    ).toBe(
      "The network fee for this transfer is above this oracle's fee limit.",
    );
  });

  it('tells a temporary Hub condition from a deterministic refusal', () => {
    for (const [status, error] of [
      [409, 'sequence_mismatch'],
      [503, 'transfer_unavailable'],
    ] as const)
      expect(hubPrepareRefusal(status, { error })?.message).toBe(
        `Auth Hub is temporarily unavailable for this (${error}); try again shortly.`,
      );
    expect(
      hubPrepareRefusal(409, {
        error: 'operation_not_enabled',
        reason: 'bank sends are off',
      })?.message,
    ).toBe(
      'This operation is not available for this account (operation_not_enabled: bank sends are off).',
    );
  });

  it('returns null for anything else', () => {
    for (const [status, body] of [
      [400, null],
      [400, 'insufficient_funds'],
      [400, {}],
      [400, { error: 'invalid_operation' }],
      [400, { error: 'toString' }],
      [400, { error: 7 }],
      [503, { error: 'insufficient_funds' }],
      [503, { error: 'down' }],
      [409, { error: 'Not A Code' }],
      [500, { error: 'sequence_mismatch' }],
    ] as const)
      expect(hubPrepareRefusal(status, body)).toBeNull();
  });
});
