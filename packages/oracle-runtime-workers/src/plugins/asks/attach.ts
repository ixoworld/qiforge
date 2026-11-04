/**
 * A file the person sent in the chat, streamed from the channel gateway's
 * media link to the upload address submit_work handed out for an answer
 * draft (asks `workers/src/draftUploads.ts`, #656: a signed R2 PUT per file).
 * The bytes never pass through the model, and neither the media link, the
 * upload address nor the signed URL is ever shown to it.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/** What asks' draft uploads take: PNG, JPG, WebP or PDF, 5 MB each (10 files, 25 MB a draft). */
export const UPLOAD_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};
export const MAX_UPLOAD_BYTES = 5_000_000;

/** A channel file as the plugin keeps it (the turn's `session.channel.attachments`). */
export interface KeptFile {
  url: string;
  sha256: string;
  mimetype: string;
  size: number;
  filename: string;
  bindingId: string;
}

/** The https origins of the gateways named in `CHANNEL_SERVICE_DID` (`did:web:<host>`, comma separated). */
export function channelOriginsOf(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.split(/[\s,]+/).flatMap((did) => {
    const host = /^did:web:([^:]+)/.exec(did)?.[1];
    if (!host) return [];
    try {
      return [new URL(`https://${decodeURIComponent(host)}`).origin];
    } catch {
      return [];
    }
  });
}

/** A file id the way asks names one: letters, digits, `_` and `-`, starting with a letter or digit. */
export function fileIdOf(name: string): string {
  const id = name
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[-_]+|-+$/g, '')
    .slice(0, 64);
  return id || 'file';
}

/** asks' refusal words, with any link taken out. */
const scrub = (words: string): string =>
  words.replace(/https?:\/\/\S+/g, 'the upload address').slice(0, 300);

/* ── asks' upload address (asks #656): sign, PUT to R2, check ───────────────
 * The only code that talks to it. `<address>` is
 * `https://{test.}api.asks.world/draft-uploads/du_…/`:
 *   POST   <address><name>  {type, bytes} → 201 {url, method: "PUT", headers}
 *   PUT    <url>            the bytes, with exactly the signed headers (R2, 10 minutes)
 *   GET    <address>        the server's check → {files, refused, missing}
 *   DELETE <address><name>
 */

/** A signed PUT asks handed out: always to R2, never anywhere else. */
export interface SignedPut {
  url: string;
  headers: Record<string, string>;
}

type Refusal = { ok: false; unreachable: boolean; words: string };

const isR2 = (url: string): boolean => {
  try {
    const one = new URL(url);
    return (
      one.protocol === 'https:' &&
      !one.username &&
      one.hostname.endsWith('.r2.cloudflarestorage.com')
    );
  } catch {
    return false;
  }
};

async function refusalOf(response: Response): Promise<Refusal> {
  const answer = (await response.json().catch(() => ({}))) as {
    words?: unknown;
    code?: unknown;
  };
  return {
    ok: false,
    unreachable: response.status >= 500,
    words:
      typeof answer.words === 'string'
        ? answer.words
        : `asks.world refused it (${String(answer.code ?? response.status)}).`,
  };
}

/** Ask asks for a signed PUT for one file of `bytes` bytes. */
export async function signDraftUpload(
  fetcher: typeof fetch,
  address: string,
  name: string,
  type: string,
  bytes: number,
): Promise<{ ok: true; put: SignedPut } | Refusal> {
  const response = await fetcher(`${address}${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, bytes }),
  }).catch(() => null);
  if (!response)
    return {
      ok: false,
      unreachable: true,
      words: 'asks.world could not be reached.',
    };
  if (!response.ok) return refusalOf(response);
  const body = (await response.json().catch(() => ({}))) as {
    url?: unknown;
    method?: unknown;
    headers?: unknown;
  };
  const headers = body.headers as Record<string, unknown> | undefined;
  if (
    typeof body.url !== 'string' ||
    !isR2(body.url) ||
    (body.method ?? 'PUT') !== 'PUT' ||
    !headers ||
    typeof headers !== 'object' ||
    !Object.values(headers).every((one) => typeof one === 'string')
  )
    return {
      ok: false,
      unreachable: false,
      words: 'asks.world gave an upload link this chat does not use.',
    };
  return {
    ok: true,
    put: { url: body.url, headers: headers as Record<string, string> },
  };
}

/** Stream the bytes to the signed URL, with exactly its headers. */
export async function putSigned(
  fetcher: typeof fetch,
  put: SignedPut,
  body: ReadableStream<Uint8Array>,
  bytes: number,
): Promise<{ ok: true } | Refusal> {
  // Workers send a stream with a Content-Length only through a FixedLengthStream.
  const Fixed = (
    globalThis as {
      FixedLengthStream?: new (
        length: number,
      ) => TransformStream<Uint8Array, Uint8Array>;
    }
  ).FixedLengthStream;
  const response = await fetcher(put.url, {
    method: 'PUT',
    headers: put.headers,
    body: Fixed ? body.pipeThrough(new Fixed(bytes)) : body,
  }).catch(() => null);
  if (!response)
    return {
      ok: false,
      unreachable: true,
      words: 'The upload did not finish.',
    };
  // R2's own error is XML, nothing to show.
  return response.ok
    ? { ok: true }
    : {
        ok: false,
        unreachable: false,
        words: `The upload was refused (${response.status}).`,
      };
}

export async function removeDraftUpload(
  fetcher: typeof fetch,
  address: string,
  name: string,
): Promise<void> {
  await fetcher(`${address}${encodeURIComponent(name)}`, {
    method: 'DELETE',
  }).catch(() => undefined);
}

/** asks' own check of what landed: the names it refused and the file ids still missing. */
export async function checkDraftUploads(
  fetcher: typeof fetch,
  address: string,
): Promise<
  | { ok: true; kept: string[]; refused: string[]; missing: string[] }
  | { ok: false }
> {
  const response = await fetcher(address, {
    headers: { accept: 'application/json' },
  }).catch(() => null);
  if (!response?.ok) return { ok: false };
  const body = (await response.json().catch(() => null)) as {
    files?: unknown;
    refused?: unknown;
    missing?: unknown;
  } | null;
  if (!body) return { ok: false };
  // Names and ids only, and only ones shaped like a file name: nothing else reaches the model.
  const names = (list: unknown, pick: (one: unknown) => unknown): string[] =>
    (Array.isArray(list) ? list : [])
      .map(pick)
      .filter(
        (one): one is string =>
          typeof one === 'string' &&
          /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(one),
      )
      .slice(0, 12);
  const named = (one: unknown) => (one as { name?: unknown } | null)?.name;
  return {
    ok: true,
    kept: names(body.files, named),
    refused: names(body.refused, named),
    missing: names(body.missing, (one) => one),
  };
}

export async function sendFile(input: {
  file: KeptFile;
  /** The file id the answer expects; else one made from the file's name. */
  name?: string;
  address: string;
  origins: readonly string[];
  fetch: typeof fetch;
}): Promise<{ ok: true; as: string } | { ok: false; why: string }> {
  const { file, address } = input;
  const ext = UPLOAD_TYPES[file.mimetype.toLowerCase()];
  if (!ext)
    return {
      ok: false,
      why: `asks takes PNG, JPG, WebP or PDF files; this one is ${file.mimetype}.`,
    };
  if (file.size > MAX_UPLOAD_BYTES)
    return {
      ok: false,
      why: 'asks takes files up to 5 MB; this one is bigger.',
    };
  let source: URL;
  try {
    source = new URL(file.url);
  } catch {
    return { ok: false, why: "The chat's copy of that file can't be read." };
  }
  if (
    !input.origins.includes(source.origin) ||
    !source.pathname.startsWith(`/media/${file.bindingId}/`)
  ) {
    return {
      ok: false,
      why: "That file isn't one the chat gateway keeps, so it was not sent.",
    };
  }

  const fetched = await input
    .fetch(source.toString(), { redirect: 'manual' })
    .catch(() => null);
  if (!fetched?.ok || !fetched.body) {
    return {
      ok: false,
      why: "The chat's copy of that file can't be read any more (links last 30 days).",
    };
  }
  // asks signs for an exact size: the gateway's own length must agree with it.
  const length = fetched.headers.get('content-length');
  if (length !== null && Number(length) !== file.size) {
    await fetched.body.cancel().catch(() => undefined);
    return {
      ok: false,
      why: 'The file changed on its way from the chat, so it was not attached.',
    };
  }
  const hash = sha256.create();
  let bytes = 0;
  const meter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > file.size) {
        controller.error(new Error('larger than the gateway said'));
        return;
      }
      hash.update(chunk);
      controller.enqueue(chunk);
    },
  });

  const as = `${input.name ?? fileIdOf(file.filename)}.${ext}`;
  const signed = await signDraftUpload(
    input.fetch,
    address,
    as,
    file.mimetype.toLowerCase(),
    file.size,
  );
  if (!signed.ok) {
    await fetched.body.cancel().catch(() => undefined);
    return {
      ok: false,
      why: signed.unreachable
        ? 'asks.world could not be reached, so the file was not attached. Try again in a minute.'
        : scrub(signed.words),
    };
  }
  const put = await putSigned(
    input.fetch,
    signed.put,
    fetched.body.pipeThrough(meter),
    file.size,
  );
  if (!put.ok && put.unreachable) {
    return bytes > file.size
      ? {
          ok: false,
          why: 'The file changed on its way from the chat, so it was not attached.',
        }
      : {
          ok: false,
          why: 'asks.world could not be reached, so the file was not attached. Try again in a minute.',
        };
  }
  if (!put.ok) return { ok: false, why: scrub(put.words) };
  if (bytes !== file.size || bytesToHex(hash.digest()) !== file.sha256) {
    await removeDraftUpload(input.fetch, address, as);
    return {
      ok: false,
      why: 'The file changed on its way from the chat, so it was taken off again.',
    };
  }
  return { ok: true, as };
}
