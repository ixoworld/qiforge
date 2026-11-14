import { z } from 'zod';
import type { RuntimeContext } from '../../plugin-api/types';

/**
 * The IXO claim bot (`claim.bot.<homeserver>`), called as this oracle with a
 * self-signed UCAN — no Matrix token. The collection entity's room is sourced
 * once by its owner when the collection is set up; an agent never sources
 * rooms, it only uploads and saves into the collection.
 */

const CidResponseSchema = z.object({ data: z.object({ cid: z.string() }) });

async function botToken(ctx: RuntimeContext, botUrl: string): Promise<string> {
  const minted = await ctx.ucan.mintSelfSignedInvocation(botUrl, {
    with: 'ixo:matrix-claims-bot',
    can: '*',
  });
  if ('error' in minted) {
    throw new Error(`Cannot authenticate to the claim bot: ${minted.error}`);
  }
  return minted.invocation;
}

/** One SurveyJS file answer, the shape the Agent Work form's `deliverables` takes. */
export interface ClaimFileAnswer {
  name: string;
  type: string;
  /** JSON string: the portal's `mediaAttachment` descriptor. */
  content: string;
}

/**
 * Upload a deliverable into the collection's encrypted media lane. Returns the
 * `mediaAttachment` answer the evaluator resolves (same shape the portal and
 * eval-oracle's `submit-claim` write).
 */
export async function uploadDeliverable(
  ctx: RuntimeContext,
  input: {
    botUrl: string;
    collectionId: string;
    fileName: string;
    mediaType: string;
    bytes: Uint8Array;
  },
): Promise<ClaimFileAnswer> {
  const form = new FormData();
  form.append('collection', input.collectionId);
  // The bot's exact-length contract: a `size` field BEFORE the file. Without
  // it the bot guesses from Content-Length, which workerd's multipart encoding
  // throws off ("file is longer than the N bytes expected").
  form.append('size', String(input.bytes.byteLength));
  form.append(
    'file',
    new File([input.bytes], input.fileName, { type: input.mediaType }),
  );
  const res = await fetch(`${input.botUrl}/media/upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await botToken(ctx, input.botUrl)}`,
      'x-auth-type': 'ucan',
    },
    body: form,
  });
  if (!res.ok) {
    throw new Error(
      `Deliverable upload failed (${res.status}): ${await res.text()}`,
    );
  }
  const { cid } = CidResponseSchema.parse(await res.json()).data;
  return {
    name: input.fileName,
    type: input.mediaType,
    content: JSON.stringify({
      id: `{id}#${cid}`,
      type: 'mediaAttachment',
      proof: cid,
      encrypted: true,
      mediaType: input.mediaType,
      description: '',
      serviceEndpoint: `${input.botUrl}/media/collections/${input.collectionId}/${cid}`,
    }),
  };
}

/** Save the claim body into the collection; the returned cid IS the claim id. */
export async function saveClaim(
  ctx: RuntimeContext,
  input: { botUrl: string; collectionId: string; body: object },
): Promise<string> {
  const res = await fetch(`${input.botUrl}/action`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await botToken(ctx, input.botUrl)}`,
      'x-auth-type': 'ucan',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      action: 'save-claim',
      flags: {
        collection: input.collectionId,
        data: JSON.stringify(input.body),
      },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Saving the claim failed (${res.status}): ${await res.text()}`,
    );
  }
  return CidResponseSchema.parse(await res.json()).data.cid;
}
