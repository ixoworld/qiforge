import protobuf from 'protobufjs/minimal.js';
import {
  TxRaw,
  TxBody,
} from '@ixo/impactxclient-sdk/module/codegen/cosmos/tx/v1beta1/tx.js';
import { MsgSend } from '@ixo/impactxclient-sdk/module/codegen/cosmos/bank/v1beta1/tx.js';
import { describe, expect, it, vi } from 'vitest';
import {
  digestActionProposal,
  type ActionProposal,
} from '@ixo/ixo-transaction/action-proposals';
import { proposalSubject } from './fixtures/proposal';
import { verifyActionTransaction } from './verify';
async function fixture(memo?: string) {
  const subject = proposalSubject();
  const proposal: ActionProposal = {
    ...subject,
    digest: await digestActionProposal(subject),
    lifecycle: { status: 'unknown', claimedAt: subject.createdAt },
  };
  const msg = proposal.action.inputs.messages[0]!;
  const value = MsgSend.encode(
    MsgSend.fromJSON(msg.value),
    new protobuf.Writer(),
  ).finish();
  const body = TxBody.encode(
    TxBody.fromPartial({
      messages: [{ typeUrl: msg.typeUrl, value }],
      memo: memo ?? proposal.id,
    }),
    new protobuf.Writer(),
  ).finish();
  const bytes = TxRaw.encode(
    TxRaw.fromPartial({
      bodyBytes: body,
      authInfoBytes: new Uint8Array(),
      signatures: [new Uint8Array([1])],
    }),
    new protobuf.Writer(),
  ).finish();
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (v) => v.toString(16).padStart(2, '0'),
  )
    .join('')
    .toUpperCase();
  const base64 = btoa(
    Array.from(bytes, (b) => String.fromCharCode(b)).join(''),
  );
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) =>
    String(input).includes('/status')
      ? Response.json({ result: { node_info: { network: 'pandora-8' } } })
      : Response.json({
          result: { hash, height: '42', tx: base64, tx_result: { code: 0 } },
        }),
  );
  return { proposal, hash, fetcher };
}
describe('chain verified action outcomes', () => {
  it('verifies exact bytes and chain before accepting an included transaction', async () => {
    const { proposal, hash, fetcher } = await fixture();
    expect(
      await verifyActionTransaction(
        proposal,
        hash,
        'https://rpc.test',
        fetcher,
      ),
    ).toMatchObject({ transactionHash: hash, height: 42, code: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('preserves a configured RPC base path', async () => {
    const { proposal, hash, fetcher } = await fixture();
    await verifyActionTransaction(
      proposal,
      hash,
      'https://rpc.test/rpc/',
      fetcher,
    );
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      'https://rpc.test/rpc/status',
    );
    expect(String(fetcher.mock.calls[1]![0])).toContain('/rpc/tx?hash=');
  });
  it.each(['', 'ap_00000000-0000-4000-8000-000000000000'])(
    'rejects a transaction whose memo is not this card (%j)',
    async (memo) => {
      const { proposal, hash, fetcher } = await fixture(memo);
      await expect(
        verifyActionTransaction(proposal, hash, 'https://rpc.test', fetcher),
      ).rejects.toThrow('memo mismatch');
    },
  );
  it('rejects a different transaction and never trusts an asserted success', async () => {
    const { proposal, hash, fetcher } = await fixture();
    await expect(
      verifyActionTransaction(
        proposal,
        'A'.repeat(64),
        'https://rpc.test',
        fetcher,
      ),
    ).rejects.toThrow('hash mismatch');
    proposal.action.inputs.messages[0]!.value.amount = [
      { denom: 'uixo', amount: '9000000' },
    ];
    await expect(
      verifyActionTransaction(proposal, hash, 'https://rpc.test', fetcher),
    ).rejects.toThrow('subject mismatch');
  });
  it('rejects the wrong chain, unavailable RPC, unsafe origin and absent inclusion', async () => {
    const { proposal, hash, fetcher } = await fixture();
    proposal.action.chainId = 'other-1';
    await expect(
      verifyActionTransaction(proposal, hash, 'https://rpc.test', fetcher),
    ).rejects.toThrow('Chain mismatch');
    await expect(
      verifyActionTransaction(proposal, hash, 'http://rpc.test', fetcher),
    ).rejects.toThrow('HTTPS');
    fetcher.mockResolvedValue(new Response('', { status: 503 }));
    await expect(
      verifyActionTransaction(proposal, hash, 'https://rpc.test', fetcher),
    ).rejects.toThrow('unavailable');
  });
});
