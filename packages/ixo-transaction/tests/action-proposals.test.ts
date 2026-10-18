import { describe, expect, it } from 'vitest';
import { bech32 } from '@scure/base';
import {
  ActionReferenceSchema,
  assertActionProposalUnchanged,
  digestActionProposal,
  canonicalizeFinalDecisionSubject,
  actionProposalSubject,
  ActionProposalSchema,
  IxoAddressSchema,
  type ActionProposalSubject,
} from '../src/action-proposals.js';
import { validateTransactionDraft } from '../src/validate.js';
const ADDRESS = bech32.encodeFromBytes('ixo', new Uint8Array(20).fill(1));
const ADDRESS_2 = bech32.encodeFromBytes('ixo', new Uint8Array(20).fill(2));
function subject(): ActionProposalSubject {
  const draft = validateTransactionDraft({
    command: '/ixo bank send',
    network: 'testnet',
    value: {
      fromAddress: ADDRESS,
      toAddress: ADDRESS_2,
      amount: [{ denom: 'uixo', amount: '1000000' }],
    },
  });
  return {
    v: 1,
    id: 'ap_01234567-0123-4123-8123-0123456789ab',
    ownerDid: `did:ixo:${ADDRESS}`,
    title: 'Send 1 IXO',
    origin: { sessionId: 's', runId: 'r', invocationId: 'i' },
    action: {
      name: 'sign_transaction',
      schemaVersion: '1',
      network: 'testnet',
      chainId: 'pandora-8',
      signerAddress: ADDRESS,
      inputs: {
        action: 'sign_transaction',
        network: 'testnet',
        chainId: 'pandora-8',
        messages: [draft.message],
        intent: draft.intent,
        risks: draft.risks,
        riskLevel: draft.riskLevel,
        requiresConfirmation: true,
      },
      targets: [ADDRESS_2],
    },
    evidenceRefs: ['session:s:request:r'],
    createdAt: '2026-10-18T10:00:00.000Z',
    expiresAt: '2026-10-18T10:15:00.000Z',
  };
}
describe('portable action proposal contract', () => {
  it.each([
    'ixo1oooooooooooooooooooo',
    `${ADDRESS.slice(0, -1)}q`,
    bech32.encodeFromBytes('cosmos', new Uint8Array(20).fill(1)),
    bech32.encodeFromBytes('ixo', new Uint8Array(19).fill(1)),
    bech32.encodeFromBytes('ixo', new Uint8Array(21).fill(1)),
    ADDRESS.toUpperCase(),
  ])(
    'rejects invalid account addresses at the proposal boundary %s',
    (address) => {
      expect(IxoAddressSchema.safeParse(address).success).toBe(false);
      const s = subject();
      expect(
        ActionProposalSchema.safeParse({
          ...s,
          digest: 'a'.repeat(64),
          lifecycle: { status: 'prepared' },
          action: { ...s.action, signerAddress: address },
        }).success,
      ).toBe(false);
      expect(
        ActionProposalSchema.safeParse({
          ...s,
          digest: 'a'.repeat(64),
          lifecycle: { status: 'prepared' },
          action: { ...s.action, targets: [address] },
        }).success,
      ).toBe(false);
      for (const field of ['fromAddress', 'toAddress']) {
        const forged = structuredClone(s);
        forged.action.inputs.messages[0]!.value[field] = address;
        expect(
          ActionProposalSchema.safeParse({
            ...forged,
            digest: 'a'.repeat(64),
            lifecycle: { status: 'prepared' },
          }).success,
        ).toBe(false);
      }
    },
  );
  it('uses the same canonical JSON and SHA-256 in browser-compatible Web Crypto', async () => {
    const s = subject();
    const digest = await digestActionProposal(s);
    const text = canonicalizeFinalDecisionSubject({
      kind: 'action-proposal/v1',
      action: JSON.parse(JSON.stringify(s)),
    });
    const expected = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
      ),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    expect(digest).toBe(expected);
    const proposal = ActionProposalSchema.parse({
      ...s,
      digest,
      lifecycle: { status: 'prepared' },
    });
    expect(await assertActionProposalUnchanged(proposal)).toEqual(proposal);
    expect(actionProposalSubject(proposal)).toEqual(s);
    expect(
      await assertActionProposalUnchanged({
        ...proposal,
        lifecycle: { status: 'claimed', claimedAt: s.createdAt },
      }),
    ).toBeDefined();
    await expect(
      assertActionProposalUnchanged({
        ...proposal,
        title: 'Send another amount',
      }),
    ).rejects.toThrow('changed after authorization');
  });
  it('rejects signer, target, network, schema and expiry inconsistencies', () => {
    const s = subject();
    expect(() =>
      ActionProposalSchema.parse({
        ...s,
        digest: 'a'.repeat(64),
        lifecycle: { status: 'prepared' },
        expiresAt: s.createdAt,
      }),
    ).toThrow();
    expect(() =>
      ActionProposalSchema.parse({
        ...s,
        digest: 'a'.repeat(64),
        lifecycle: { status: 'prepared' },
        action: { ...s.action, signerAddress: ADDRESS_2 },
      }),
    ).toThrow();
    expect(() =>
      ActionProposalSchema.parse({
        ...s,
        digest: 'a'.repeat(64),
        lifecycle: { status: 'prepared' },
        action: { ...s.action, targets: [ADDRESS] },
      }),
    ).toThrow();
  });
  it('allows only opaque HTTPS locator URLs without executable context', () => {
    const s = subject();
    const ref = {
      proposalId: s.id,
      title: s.title,
      url: `https://portal.test/a/${s.id}`,
      expiresAt: s.expiresAt,
      digest: 'a'.repeat(64),
    };
    expect(ActionReferenceSchema.parse(ref)).toEqual(ref);
    for (const url of [
      `https://portal.test/a/${s.id}?did=foo`,
      `https://portal.test/a/${s.id}#grant=x`,
      `http://portal.test/a/${s.id}`,
      `https://portal.test/a/did:ixo:foo`,
    ])
      expect(ActionReferenceSchema.safeParse({ ...ref, url }).success).toBe(
        false,
      );
  });
});
