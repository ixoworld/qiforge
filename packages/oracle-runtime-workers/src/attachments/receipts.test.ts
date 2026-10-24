import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { receiveAttachments, sessionAttachments } from './receipts';
import { cleanAdditionalKwargs } from '../sqlite/serialization';

const context = { userDid: 'did:ixo:alice', sessionId: 's1' };
const meta = {
  filename: 'report.pdf',
  mimetype: 'application/pdf',
  mxcUri: 'mxc://example/file',
  category: 'document',
};
async function fixture() {
  const messageId = 'm1';
  const receipts = await receiveAttachments({
    ...context,
    messageId,
    receivedAt: '2026-10-24T07:00:00.000Z',
    metas: [meta],
  });
  const message = new HumanMessage({
    id: messageId,
    content: 'file',
    additional_kwargs: { attachments: [meta], attachmentReceipts: receipts },
  });
  const source = sessionAttachments({
    userDid: context.userDid,
    messages: async (id) => (id === context.sessionId ? [message] : undefined),
  });
  return { source, message, receipts };
}
describe('session attachment receipts', () => {
  it('binds immutable metadata and host receipt time to the saved human message', async () => {
    const { source, message, receipts } = await fixture();
    const inventory = await source.inventory(context);
    expect(inventory.complete).toBe(true);
    expect(inventory.receipts).toEqual(receipts);
    expect(
      await source.current(context, inventory.reference, inventory.revision),
    ).toBe(true);
    expect(
      cleanAdditionalKwargs(message.additional_kwargs, false, 'Test')
        .attachmentReceipts,
    ).toEqual(receipts);
  });
  it('refuses another user and does not reuse another session receipt', async () => {
    const { source, receipts } = await fixture();
    const receipt = receipts[0];
    if (!receipt) throw new Error('missing receipt');
    await expect(
      source.inventory({ ...context, userDid: 'did:ixo:bob' }),
    ).rejects.toThrow('owner mismatch');
    expect(
      await source.current(
        { ...context, sessionId: 'other' },
        receipt.reference,
        receipt.revision,
      ),
    ).toBe(false);
  });
  it('marks legacy attachments partial without inventing an original upload time', async () => {
    const { source, message } = await fixture();
    delete message.additional_kwargs.attachmentReceipts;
    expect(await source.inventory(context)).toMatchObject({
      receipts: [],
      complete: false,
    });
  });
  it('invalidates both receipt and inventory when saved metadata changes', async () => {
    const { source, message, receipts } = await fixture();
    const before = await source.inventory(context);
    message.additional_kwargs.attachments = [
      { ...meta, filename: 'different.pdf' },
    ];
    expect(
      await source.current(context, before.reference, before.revision),
    ).toBe(false);
    const receipt = receipts[0];
    if (!receipt) throw new Error('missing receipt');
    expect(
      await source.current(context, receipt.reference, receipt.revision),
    ).toBe(false);
    expect((await source.inventory(context)).complete).toBe(false);
  });
});
