/**
 * The attachments of one turn attempt: which files the run reads, how a
 * channel file's `channel:` reference becomes its link (server-side, never
 * through the model), and when nothing is downloaded at all.
 */
import {
  attachmentMetaFor,
  channelAttachmentRef,
  channelMediaOrigins,
  createChannelMediaSource,
  parseAttachmentInputs,
  type AttachmentInput,
  type ChannelAttachmentLinkStore,
  type ChannelMediaLink,
  type ChannelMediaSource,
  type PreparedAttachments,
} from '../attachments';
import { parseChannelServiceDids } from '../channels/auth';
import {
  channelAttachmentInputs,
  type ChannelAttachment,
} from '../channels/contract';
import type { AttachmentMeta } from '../sqlite/serialization';

/** The part of a turn request the attachment inputs come from. */
interface TurnFiles {
  client: string;
  attachments?: unknown;
  channel?: { bindingId: string; attachments?: readonly ChannelAttachment[] };
}

/**
 * What the run reads: a channel turn's files by their `channel:` reference
 * (from the gateway's list on the request), otherwise the request body's
 * attachments as the Portal and Matrix send them. A body can never name a
 * `channel:` reference itself.
 */
export function turnAttachmentInputs(
  req: TurnFiles,
  bodyAttachments: unknown,
): AttachmentInput[] {
  const files = req.client === 'channel' ? req.channel?.attachments : undefined;
  if (files?.length) return channelAttachmentInputs(files);
  return parseAttachmentInputs(bodyAttachments ?? req.attachments);
}

/** A channel turn's files as the links the owner object resolves references to. */
export function channelTurnLinks(
  req: TurnFiles,
): Array<ChannelMediaLink & { ref: string }> {
  if (req.client !== 'channel' || !req.channel?.attachments?.length) return [];
  const bindingId = req.channel.bindingId;
  return req.channel.attachments.map((file) => ({
    ref: channelAttachmentRef(file.sha256),
    url: file.url,
    sha256: file.sha256,
    bindingId,
  }));
}

/**
 * The channel source of a turn in `sessionId`: a reference resolves to the
 * turn's own files first, then to the links kept for the session; only the
 * gateways of `CHANNEL_SERVICE_DID` are fetched from.
 */
export function turnChannelMediaSource(input: {
  sessionId: string;
  turnLinks: ReadonlyArray<ChannelMediaLink & { ref: string }>;
  store: Pick<ChannelAttachmentLinkStore, 'get'> | null;
  channelServiceDid: string | undefined;
}): ChannelMediaSource {
  return createChannelMediaSource({
    origins: channelMediaOrigins(
      parseChannelServiceDids(input.channelServiceDid),
    ),
    resolve: async (ref) => {
      const own = input.turnLinks.find((link) => link.ref === ref);
      if (own) return own;
      return input.store?.get(input.sessionId, ref);
    },
  });
}

/**
 * The turn's prepared attachments, or none: a resumed attempt hands the
 * graph no new input (the person's message, with its files, is already in
 * the checkpoint), so nothing is downloaded again; its metadata is still
 * known for `view_attachment`.
 */
export async function prepareTurnAttachments(input: {
  inputs: readonly AttachmentInput[];
  resumed: boolean;
  prepare: () => Promise<PreparedAttachments>;
}): Promise<{ prepared: PreparedAttachments | null; metas: AttachmentMeta[] }> {
  if (input.inputs.length === 0) return { prepared: null, metas: [] };
  if (input.resumed)
    return {
      prepared: null,
      metas: input.inputs.map((attachment) => attachmentMetaFor(attachment)),
    };
  const prepared = await input.prepare();
  return { prepared, metas: prepared.metas };
}
