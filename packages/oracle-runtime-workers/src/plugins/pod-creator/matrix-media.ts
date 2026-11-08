/**
 * Public documents on the oracle's homeserver for the POD creator's linked
 * resources (the profile, the domain card): reserved when a batch is
 * prepared, uploaded only once the user approved the batch that names them.
 *
 * Reserving is Matrix's asynchronous upload (client-server API v1.7):
 * `POST /_matrix/media/v1/create` answers a `content_uri` before any content
 * exists, so a message can name the document's download URL and proof while
 * nothing is public yet, and `PUT /_matrix/media/v3/upload/{serverName}/{mediaId}`
 * uploads it later. The homeserver refuses a second upload to the same id
 * (409 `M_CANNOT_OVERWRITE_MEDIA`): for a document of ours that is the same
 * bytes, already public. An id never uploaded to expires at the answer's
 * `unused_expires_at` (24 h on Synapse); then the upload is a 404.
 *
 * Every request is made as the oracle's plugin device
 * (`ctx.matrix.botCredentials`), bounded in time and by the turn's abort; a
 * 401 asks the host once for fresh credentials and tries again. Expected
 * failures come back as a {@link GatewayRefusal}; only the turn's abort is
 * thrown.
 */
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { z } from 'zod';
import { MXC_PATTERN } from '../../attachments/download';
import {
  boundedBytes,
  fetchWithoutRedirects,
} from '../../core/domain-context/transport';
import type { RuntimeContext } from '../../plugin-api/types';
import {
  MIN_ATTEMPT_MS,
  errorBodyOf,
  throwIfAborted,
  untilAborted,
} from '../ixo-chain/http';
import type {
  GatewayRefusal,
  GatewayResult,
  PendingDocument,
} from './chain-gateway';

/** The most of a homeserver answer read (they are small JSON objects). */
const ANSWER_MAX_BYTES = 16 * 1024;

/**
 * `ctx.kv` namespace remembering, per homeserver and document proof, the
 * media a document was reserved as (and whether it was uploaded), so
 * preparing the same document again reuses it instead of reserving another.
 */
export const DOCUMENT_CACHE_NAMESPACE = 'pod-creator/public-documents';
/** How long a remembered document lives without being used. */
export const DOCUMENT_CACHE_TTL_MS = 60 * 60 * 1000;
const DOCUMENT_CACHE_MAX_ENTRIES = 100;
/** A reservation this close to expiring is not reused: its upload could come too late. */
const RESERVATION_MARGIN_MS = 60 * 60 * 1000;

const REDIRECTED = 'homeserver-redirected';

/** What bounds the homeserver exchanges; every member is required. */
export interface MatrixMediaDeps {
  fetch: typeof fetch;
  /** Upper bound on one homeserver request, its answer included. */
  requestTimeoutMs: number;
  /** Upper bound on getting the plugin device's credentials. */
  credentialsTimeoutMs: number;
}

/** A document to make public, as the exact text whose SHA-256 is its proof. */
export interface PublicDocument {
  text: string;
  filename: string;
  contentType: string;
}

/** Where a reserved document will be readable, and what is left to upload (null: it is public). */
export interface ReservedDocument {
  url: string;
  pending: PendingDocument | null;
}

/** The SHA-256 of `text`'s UTF-8 bytes, lower-case hex: a document's proof. */
export function documentProof(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

const refuse = (message: string, retryable: boolean): GatewayRefusal => ({
  ok: false,
  message,
  retryable,
});

const OUT_OF_TIME = refuse(
  'The homeserver step ran out of time; try again in a moment.',
  true,
);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Device {
  baseUrl: string;
  accessToken: string;
}

/**
 * The oracle's plugin device, within its time bound and the turn. `rejected`
 * is the token the homeserver just refused: the host re-validates or
 * re-logs the device and answers with fresh credentials.
 */
async function pluginDevice(
  ctx: RuntimeContext,
  deps: MatrixMediaDeps,
  deadline: number,
  rejected?: string,
): Promise<Device | GatewayRefusal> {
  const left = deadline - Date.now();
  if (left < MIN_ATTEMPT_MS) return OUT_OF_TIME;
  const ms = Math.min(deps.credentialsTimeoutMs, left);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    const answer = await untilAborted(
      Promise.race([
        rejected === undefined
          ? ctx.matrix.botCredentials()
          : ctx.matrix.botCredentials({ rejected }),
        timeout,
      ]),
      ctx.abortSignal,
    );
    if (answer === 'timeout')
      return refuse(
        "The oracle's Matrix device did not answer in time; try again in a moment.",
        true,
      );
    return {
      baseUrl: answer.baseUrl.replace(/\/+$/, ''),
      accessToken: answer.accessToken,
    };
  } catch (error) {
    throwIfAborted(ctx.abortSignal);
    return refuse(
      `The oracle's Matrix device is unavailable (${errorText(error)}); try again in a moment.`,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** A homeserver answer: its status, its JSON body (undefined when it is not JSON) and its `errcode`. */
interface Answer {
  status: number;
  body: unknown;
  errcode: string | undefined;
}

const errcodeSchema = z.object({ errcode: z.string() });

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** One bounded request to the device's homeserver; a refusal when it got no answer. */
async function request(
  ctx: RuntimeContext,
  deps: MatrixMediaDeps,
  deadline: number,
  device: Device,
  path: string,
  init: { method: string; contentType?: string; body?: Uint8Array },
): Promise<Answer | GatewayRefusal> {
  const left = deadline - Date.now();
  if (left < MIN_ATTEMPT_MS) return OUT_OF_TIME;
  const ms = Math.min(deps.requestTimeoutMs, left);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchWithoutRedirects(
      deps.fetch,
      `${device.baseUrl}${path}`,
      {
        method: init.method,
        headers: {
          authorization: `Bearer ${device.accessToken}`,
          ...(init.contentType ? { 'content-type': init.contentType } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
        signal: controller.signal,
      },
      REDIRECTED,
    );
    const text = response.ok
      ? new TextDecoder().decode(await boundedBytes(response, ANSWER_MAX_BYTES))
      : await errorBodyOf(response);
    const body = parseJson(text);
    const errcode = errcodeSchema.safeParse(body);
    return {
      status: response.status,
      body,
      errcode: errcode.success ? errcode.data.errcode : undefined,
    };
  } catch (error) {
    throwIfAborted(ctx.abortSignal);
    if (controller.signal.aborted)
      return refuse(
        'The homeserver did not answer in time; try again in a moment.',
        true,
      );
    if (error instanceof Error && error.message === REDIRECTED)
      return refuse(
        'The homeserver redirected the request, which the oracle does not follow.',
        false,
      );
    if (error instanceof Error && error.message === 'document-too-large')
      return refuse(
        'The homeserver answered with far more than expected.',
        false,
      );
    return refuse(
      `The homeserver could not be reached (${error instanceof Error ? error.name : 'unknown error'}); try again in a moment.`,
      true,
    );
  } finally {
    clearTimeout(timer);
    ctx.abortSignal.removeEventListener('abort', onAbort);
  }
}

/**
 * {@link request} as the plugin device, asking once for fresh credentials
 * when the homeserver answers 401 (a token it no longer accepts).
 */
async function asPluginDevice(
  ctx: RuntimeContext,
  deps: MatrixMediaDeps,
  deadline: number,
  path: (device: Device) => string,
  init: { method: string; contentType?: string; body?: Uint8Array },
): Promise<{ device: Device; answer: Answer } | GatewayRefusal> {
  let device = await pluginDevice(ctx, deps, deadline);
  if ('ok' in device) return device;
  let answer = await request(ctx, deps, deadline, device, path(device), init);
  if ('ok' in answer) return answer;
  if (answer.status === 401) {
    ctx.logger.warn(
      '[pod-creator] the homeserver rejected the plugin device token; asking for fresh credentials',
    );
    device = await pluginDevice(ctx, deps, deadline, device.accessToken);
    if ('ok' in device) return device;
    answer = await request(ctx, deps, deadline, device, path(device), init);
    if ('ok' in answer) return answer;
  }
  return { device, answer };
}

/** A failed answer as a refusal: retryable for a 401 that persisted, 429 or 5xx. */
function refusalOf(what: string, answer: Answer): GatewayRefusal {
  const code = answer.errcode ? ` ${answer.errcode}` : '';
  const retryable =
    answer.status === 401 || answer.status === 429 || answer.status >= 500;
  return refuse(
    `The homeserver refused ${what} (HTTP ${answer.status}${code})${retryable ? '; try again in a moment.' : '.'}`,
    retryable,
  );
}

/** The public download URL of `mxc` on `baseUrl`, the one the Portal's `mxcUrlToHttp` forms. */
function downloadUrl(baseUrl: string, mxc: string): string | null {
  const match = MXC_PATTERN.exec(mxc);
  return match
    ? `${baseUrl}/_matrix/media/v3/download/${match[1]}/${match[2]}`
    : null;
}

const contentUriSchema = z.object({
  content_uri: z.string(),
  unused_expires_at: z.number().optional(),
});

const cachedSchema = z.object({
  mxc: z.string(),
  /** Epoch ms the unused reservation expires; null once uploaded. */
  reservedUntil: z.number().nullable(),
});

type Cached = z.infer<typeof cachedSchema>;

const cacheKey = (baseUrl: string, proof: string): string =>
  JSON.stringify([baseUrl, proof]);

async function cached(
  ctx: RuntimeContext,
  baseUrl: string,
  proof: string,
): Promise<Cached | undefined> {
  if (!ctx.kv) return undefined;
  const parsed = cachedSchema.safeParse(
    await ctx.kv.get(DOCUMENT_CACHE_NAMESPACE, cacheKey(baseUrl, proof)),
  );
  if (!parsed.success) return undefined;
  const { reservedUntil } = parsed.data;
  return reservedUntil === null ||
    reservedUntil - RESERVATION_MARGIN_MS > Date.now()
    ? parsed.data
    : undefined;
}

async function remember(
  ctx: RuntimeContext,
  baseUrl: string,
  proof: string,
  entry: Cached,
): Promise<void> {
  await ctx.kv?.set(DOCUMENT_CACHE_NAMESPACE, cacheKey(baseUrl, proof), entry, {
    idleTtlMs: DOCUMENT_CACHE_TTL_MS,
    maxEntries: DOCUMENT_CACHE_MAX_ENTRIES,
  });
}

/** Upload `document` now (`POST /_matrix/media/v3/upload`), for a homeserver without async uploads. */
async function uploadDirectly(
  ctx: RuntimeContext,
  deps: MatrixMediaDeps,
  deadline: number,
  document: PublicDocument,
): Promise<GatewayResult<{ mxc: string; baseUrl: string }>> {
  const sent = await asPluginDevice(
    ctx,
    deps,
    deadline,
    () =>
      `/_matrix/media/v3/upload?filename=${encodeURIComponent(document.filename)}`,
    {
      method: 'POST',
      contentType: document.contentType,
      body: new TextEncoder().encode(document.text),
    },
  );
  if ('ok' in sent) return sent;
  if (sent.answer.status !== 200)
    return refusalOf('the document upload', sent.answer);
  const parsed = contentUriSchema.safeParse(sent.answer.body);
  if (!parsed.success || !MXC_PATTERN.test(parsed.data.content_uri))
    return refuse(
      'The homeserver answered the document upload without a valid content URI.',
      false,
    );
  return {
    ok: true,
    mxc: parsed.data.content_uri,
    baseUrl: sent.device.baseUrl,
  };
}

/**
 * Reserve `document` on the oracle's homeserver and return its public
 * download URL, with the upload still to do after approval. A document of
 * the same bytes already reserved (or uploaded) for this user is reused.
 */
export async function reservePublicDocument(
  ctx: RuntimeContext,
  document: PublicDocument,
  deps: MatrixMediaDeps,
  deadline: number,
): Promise<GatewayResult<ReservedDocument>> {
  const proof = documentProof(document.text);
  const device = await pluginDevice(ctx, deps, deadline);
  if ('ok' in device) return device;
  const pendingOf = (mxc: string): PendingDocument => ({
    mxc,
    contentType: document.contentType,
    filename: document.filename,
    text: document.text,
  });
  const known = await cached(ctx, device.baseUrl, proof);
  const knownUrl = known && downloadUrl(device.baseUrl, known.mxc);
  if (known && knownUrl)
    return {
      ok: true,
      url: knownUrl,
      pending: known.reservedUntil === null ? null : pendingOf(known.mxc),
    };
  const created = await asPluginDevice(
    ctx,
    deps,
    deadline,
    () => '/_matrix/media/v1/create',
    { method: 'POST' },
  );
  if ('ok' in created) return created;
  const { answer } = created;
  if (
    answer.status === 404 ||
    answer.status === 405 ||
    answer.errcode === 'M_UNRECOGNIZED'
  ) {
    // A homeserver before client-server API v1.7 has no asynchronous
    // upload, so nothing can be reserved: the document is uploaded now and
    // is public before the user approves the batch that names it.
    ctx.logger.warn(
      '[pod-creator] the homeserver has no asynchronous upload; uploading the document before approval',
    );
    const uploaded = await uploadDirectly(ctx, deps, deadline, document);
    if (!uploaded.ok) return uploaded;
    const url = downloadUrl(uploaded.baseUrl, uploaded.mxc);
    if (!url)
      return refuse('The homeserver answered an invalid content URI.', false);
    await remember(ctx, uploaded.baseUrl, proof, {
      mxc: uploaded.mxc,
      reservedUntil: null,
    });
    return { ok: true, url, pending: null };
  }
  if (answer.status !== 200) return refusalOf('reserving the document', answer);
  const parsed = contentUriSchema.safeParse(answer.body);
  const url = parsed.success
    ? downloadUrl(created.device.baseUrl, parsed.data.content_uri)
    : null;
  if (!parsed.success || !url)
    return refuse(
      'The homeserver answered the reservation without a valid content URI.',
      false,
    );
  await remember(ctx, created.device.baseUrl, proof, {
    mxc: parsed.data.content_uri,
    reservedUntil: parsed.data.unused_expires_at ?? Date.now(),
  });
  return { ok: true, url, pending: pendingOf(parsed.data.content_uri) };
}

/**
 * Upload each reserved document (`PUT /_matrix/media/v3/upload/{server}/{id}`).
 * A 409 for the id is a document uploaded before: a success.
 */
export async function publishPendingDocuments(
  ctx: RuntimeContext,
  documents: readonly PendingDocument[],
  deps: MatrixMediaDeps,
  deadline: number,
): Promise<GatewayResult<object>> {
  for (const document of documents) {
    const match = MXC_PATTERN.exec(document.mxc);
    if (!match)
      return refuse(
        `The prepared document names an invalid content URI; prepare it again.`,
        false,
      );
    const sent = await asPluginDevice(
      ctx,
      deps,
      deadline,
      () =>
        `/_matrix/media/v3/upload/${match[1]}/${match[2]}?filename=${encodeURIComponent(document.filename)}`,
      {
        method: 'PUT',
        contentType: document.contentType,
        body: new TextEncoder().encode(document.text),
      },
    );
    if ('ok' in sent) return sent;
    const { status } = sent.answer;
    if (status === 404)
      return refuse(
        'The reserved upload slot for the document expired before it was used; prepare it again.',
        false,
      );
    if (status !== 200 && status !== 409)
      return refusalOf('the document upload', sent.answer);
    await remember(ctx, sent.device.baseUrl, documentProof(document.text), {
      mxc: document.mxc,
      reservedUntil: null,
    });
  }
  return { ok: true };
}
