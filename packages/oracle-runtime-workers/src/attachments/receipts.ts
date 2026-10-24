import type { BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { contentDigest } from '../memory/retained-context';
import type { AttachmentMeta } from '../sqlite/serialization';
import { attachmentMetas, isAttachmentViewMessage } from './retention';

export const attachmentReceiptSchema = z.object({
  reference: z.string().startsWith('attachment:'),
  revision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  name: z.string(),
  receivedAt: z.string().datetime(),
  userDid: z.string(),
  sessionId: z.string(),
  messageId: z.string(),
});
export type AttachmentReceipt = z.infer<typeof attachmentReceiptSchema>;
export interface AttachmentSessionContext {
  userDid: string;
  sessionId: string;
}

export async function receiveAttachments(
  input: AttachmentSessionContext & {
    messageId: string;
    receivedAt: string;
    metas: AttachmentMeta[];
  },
): Promise<AttachmentReceipt[]> {
  return Promise.all(
    input.metas.map(async (meta, index) => {
      const reference = `attachment:${input.sessionId}:${input.messageId}:${index}`;
      const receipt = {
        reference,
        name: meta.filename,
        receivedAt: input.receivedAt,
        userDid: input.userDid,
        sessionId: input.sessionId,
        messageId: input.messageId,
      };
      const revision = await contentDigest(
        JSON.stringify([
          receipt,
          meta.filename,
          meta.mimetype,
          meta.category,
          meta.size ?? null,
          meta.mxcUri ?? null,
          meta.eventId ?? null,
        ]),
      );
      return { ...receipt, revision };
    }),
  );
}

/** The host supplies the authenticated session reader; there is no model-selected owner. */
export function sessionAttachments(input: {
  userDid: string;
  messages: (sessionId: string) => Promise<BaseMessage[] | undefined>;
  now?: () => Date;
}) {
  const inventory = async (context: AttachmentSessionContext) => {
    if (context.userDid !== input.userDid)
      throw new Error('attachment owner mismatch');
    const messages = await input.messages(context.sessionId);
    const receipts: AttachmentReceipt[] = [];
    let complete = messages !== undefined;
    for (const message of messages ?? []) {
      if (message.type !== 'human' || isAttachmentViewMessage(message))
        continue;
      const metas = attachmentMetas(message);
      if (metas.length === 0) {
        if (
          message.additional_kwargs.attachment ||
          (Array.isArray(message.additional_kwargs.attachments) &&
            message.additional_kwargs.attachments.length > 0)
        )
          complete = false;
        continue;
      }
      const stored = z
        .array(attachmentReceiptSchema)
        .safeParse(message.additional_kwargs.attachmentReceipts);
      if (
        !stored.success ||
        stored.data.length !== metas.length ||
        !message.id
      ) {
        complete = false;
        continue;
      }
      const first = stored.data[0];
      if (!first) {
        complete = false;
        continue;
      }
      const expected = await receiveAttachments({
        ...context,
        messageId: message.id,
        receivedAt: first.receivedAt,
        metas,
      });
      for (let index = 0; index < expected.length; index += 1) {
        const receipt = stored.data[index];
        const match = expected[index];
        if (
          !receipt ||
          !match ||
          JSON.stringify(receipt) !==
            JSON.stringify(attachmentReceiptSchema.parse(match))
        ) {
          complete = false;
          continue;
        }
        receipts.push(receipt);
      }
    }
    receipts.sort((left, right) =>
      left.reference.localeCompare(right.reference),
    );
    const reference = `attachment:inventory:${context.sessionId}`;
    const revision = await contentDigest(
      JSON.stringify({
        userDid: context.userDid,
        sessionId: context.sessionId,
        complete,
        receipts,
      }),
    );
    return {
      receipts,
      complete,
      reference,
      revision,
      observedAt: (input.now?.() ?? new Date()).toISOString(),
    };
  };
  return {
    inventory,
    current: async (
      context: AttachmentSessionContext,
      reference: string,
      revision: string,
    ): Promise<boolean> => {
      const snapshot = await inventory(context);
      return (
        (snapshot.reference === reference && snapshot.revision === revision) ||
        snapshot.receipts.some(
          (receipt) =>
            receipt.reference === reference && receipt.revision === revision,
        )
      );
    },
  };
}
