import { z } from 'zod';

export const ChannelTurnBody = z.strictObject({
  provider: z.literal('whatsapp'),
  bindingId: z.string().regex(/^chb_[A-Za-z0-9_-]{1,120}$/),
  bindingRevision: z.number().int().positive().safe(),
  requestId: z.string().min(1).max(180),
  remoteMessageRef: z.string().regex(/^hmac:[a-f0-9]{64}$/),
  sessionId: z.string().min(1).max(255).optional(),
  message: z.string().min(1).max(16_000),
  context: z.strictObject({ kind: z.literal('companion') }),
});

export type ChannelTurnInput = z.infer<typeof ChannelTurnBody>;

export const ChannelOrigin = z.strictObject({
  v: z.literal(1),
  transport: z.literal('whatsapp'),
  binding_id: ChannelTurnBody.shape.bindingId,
  remote_ref: ChannelTurnBody.shape.remoteMessageRef,
});

export type ChannelOrigin = z.infer<typeof ChannelOrigin>;

export function channelOrigin(
  channel: Pick<
    ChannelTurnInput,
    'provider' | 'bindingId' | 'remoteMessageRef'
  >,
): ChannelOrigin {
  return {
    v: 1,
    transport: channel.provider,
    binding_id: channel.bindingId,
    remote_ref: channel.remoteMessageRef,
  };
}

export interface ChannelIdentity {
  callerDid: string;
  provider: 'whatsapp';
  bindingId: string;
  bindingRevision: number;
}

export interface ChannelTurnResponse {
  requestId: string;
  runId: string;
  sessionId: string;
  status:
    | 'queued'
    | 'running'
    | 'recovering'
    | 'finished'
    | 'aborted'
    | 'interrupted'
    | 'failed';
  messageId?: string;
  text?: string;
}

export type ChannelTurnOutcome =
  | { ok: true; result: ChannelTurnResponse }
  | {
      ok: false;
      status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503;
      message: string;
    };

export class ChannelError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}

export async function channelRequestHash(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(raw),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function readChannelBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new ChannelError(400, 'A channel turn is required');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 64_000) {
      await reader.cancel();
      throw new ChannelError(413, 'Channel request is too large');
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new ChannelError(400, 'Channel request must be UTF-8');
  }
}
