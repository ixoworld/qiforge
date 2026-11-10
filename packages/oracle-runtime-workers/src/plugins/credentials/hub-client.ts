import { z } from 'zod';
import { CredentialsServiceError } from './errors';
import { callService, type FetchLike } from './http';

/**
 * Auth Hub permission cards: the oracle asks the Hub to show the person ONE
 * card holding 1-5 items (each a credential check or a catalogued service
 * action) and reads the answer back, item by item.
 *
 * Every call carries the oracle account's key (`x-channels-service-key`)
 * AND a UCAN invocation issued by the oracle's own DID to the Hub's did:web,
 * capability `permissions/request` on `ixo:permissions`, single use, bound
 * to the one request by its first fact: `{ method, path }` plus, for a POST,
 * `body_sha256` (hex SHA-256 of the body without its `invocation` field,
 * keys sorted, see {@link canonicalJson}). A POST carries the invocation in
 * the body's `invocation` field; a GET in `Authorization: Bearer`. The
 * `path` of the list call is the pathname and its query string, exactly as
 * sent.
 */

export const PERMISSIONS_PATH = '/api/internal/permissions';
export const PERMISSIONS_CAPABILITY = {
  can: 'permissions/request',
  with: 'ixo:permissions',
} as const;

/** Card 1: check a credential (any type, issuers and fields from the catalog). */
export interface CredentialCheckPermission {
  kind: 'credential-check';
  vct: string;
  issuers: string[];
  claims: string[];
  days: number;
}

/** Card 2: an action from the Hub's curated catalogue (`self.identity-check`). */
export interface ServiceActionPermission {
  kind: 'service-action';
  action: string;
  /** Omitted: the catalogue entry's usual length. */
  days?: number;
}

export type PermissionRequest =
  | CredentialCheckPermission
  | ServiceActionPermission;

/** The most items one card holds. */
export const MAX_PERMISSION_ITEMS = 5;

export const PERMISSION_STATUSES = [
  'pending',
  'allowed',
  'declined',
  'expired',
  'stopped',
  'stopping',
] as const;
/**
 * A card state this version knows, or `unknown` for one a newer Hub added.
 * `stopping`: the person's consent was stopped elsewhere and the UCAN store
 * has not yet confirmed the revocation; no grants are served meanwhile.
 */
export type PermissionStatus = (typeof PERMISSION_STATUSES)[number] | 'unknown';

/**
 * Parse a state as any string, then keep it when it is one of `known` and
 * map anything else to `unknown`: a Hub newer than this runtime must never
 * make a read throw.
 */
function lenientStatus<const T extends readonly string[]>(known: T) {
  return z
    .string()
    .transform((value): T[number] | 'unknown' =>
      (known as readonly string[]).includes(value)
        ? (value as T[number])
        : 'unknown',
    );
}

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const CardAnswer = z.object({
  id: z.string().regex(OPAQUE_ID),
  url: z.string().url(),
  status: z.literal('pending'),
  expiresAt: z.number().int().positive(),
});

export const GrantSchema = z.object({
  /** The catalogue entry's grant id (`link`, `offer`). */
  id: z.string().min(1).max(64).optional(),
  can: z.string().min(1),
  with: z.string().min(1),
  audience: z.string().min(1),
  expiresAt: z.number().int().positive(),
  token: z.string().min(1),
});
export type PermissionGrant = z.infer<typeof GrantSchema>;

/**
 * One item of the card as the Hub echoes it. Only what the plugin uses is
 * kept: the item's position and kind, the action of a service action (to
 * find its grants) and the outcome ids written when the person allowed it.
 */
export const ITEM_STATUSES = [
  'pending',
  'allowed',
  'stopped',
  'expired',
  'declined',
  'stopping',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number] | 'unknown';

export const ItemStateSchema = z.object({
  /** The item's own state; older answers carry only the card's. */
  status: lenientStatus(ITEM_STATUSES).optional(),
  index: z
    .number()
    .int()
    .min(0)
    .max(MAX_PERMISSION_ITEMS - 1),
  kind: z.enum(['credential-check', 'service-action']),
  action: z.string().max(128).optional(),
  // What a credential-check item asked for, as the Hub kept it. Read only to
  // tell whether a card already covers a new request; a value this version
  // cannot read is dropped, never a reason to refuse the answer.
  vct: z.string().max(512).optional().catch(undefined),
  issuers: z.array(z.string().max(256)).max(16).optional().catch(undefined),
  claims: z.array(z.string().max(100)).max(64).optional().catch(undefined),
  consentIds: z.array(z.string().min(1).max(128)).max(16).optional(),
  grants: z.array(GrantSchema).max(16).optional(),
});
export type PermissionItemState = z.infer<typeof ItemStateSchema>;

const CardStatus = z.object({
  id: z.string().regex(OPAQUE_ID),
  status: lenientStatus(PERMISSION_STATUSES),
  allowedAt: z.number().int().positive().optional(),
  expiresAt: z.number().int().positive().optional(),
});
export const StatusAnswer = CardStatus.extend({
  items: z.array(ItemStateSchema).min(1).max(MAX_PERMISSION_ITEMS),
});
export type PermissionState = z.infer<typeof StatusAnswer>;

/** The most cards the Hub lists for one person. */
export const MAX_LISTED_PERMISSIONS = 32;

/**
 * One card of the list: the status answer, plus the card's link when the
 * Hub sends one (a Hub that does not is fine: the link is then the one this
 * person's kv kept).
 */
const ListedCard = StatusAnswer.extend({
  url: z.string().url().optional().catch(undefined),
});
export type ListedPermission = z.infer<typeof ListedCard>;

const ListAnswer = z.object({ permissions: z.array(z.unknown()) });

export interface PermissionCard {
  id: string;
  url: string;
  status: 'pending';
  expiresAt: number;
}

/**
 * JSON with every object's keys in code-unit order, no whitespace: the
 * form the Hub hashes. Arrays keep their order.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** `body_sha256` of a JSON body: hex SHA-256 of its canonical form. */
export function jsonBodySha256(body: unknown): Promise<string> {
  return sha256Hex(canonicalJson(body));
}

/** `body_sha256` of a Hub POST: the hash of the body without its `invocation` field. */
export async function permissionBodySha256(
  body: Record<string, unknown>,
): Promise<string> {
  const { invocation: _invocation, ...rest } = body;
  void _invocation;
  return jsonBodySha256(rest);
}

/** Mints one single-use invocation bound by `facts` (throws when it cannot). */
export type MintInvocation = (
  facts: Record<string, unknown>[],
) => Promise<string>;

export interface HubPermissionsClientOptions {
  /** The Hub's origin. */
  hubUrl: string;
  /** The oracle account's key (`AUTH_HUB_CHANNEL_SERVICE_KEY`). */
  serviceKey: string;
  mint: MintInvocation;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** The tool's deadline (unix ms), see `ServiceCall.deadline`. */
  deadline?: number;
  now?: () => number;
}

export class HubPermissionsClient {
  private readonly origin: string;

  constructor(private readonly opts: HubPermissionsClientOptions) {
    this.origin = new URL(opts.hubUrl).origin;
    if (!opts.serviceKey) throw new Error('The Hub service key is required');
  }

  private invalid(): never {
    throw new CredentialsServiceError({
      service: 'hub',
      status: 502,
      code: 'invalid_response',
    });
  }

  /** Ask the Hub for a card; idempotent on `requestKey`. */
  async request(input: {
    bindingId: string;
    bindingRevision: number;
    requestKey: string;
    expiresAt: number;
    /** 1-5 items for the one card. */
    permissions: PermissionRequest[];
  }): Promise<PermissionCard> {
    const unsigned: Record<string, unknown> = {
      bindingId: input.bindingId,
      bindingRevision: input.bindingRevision,
      requestKey: input.requestKey,
      expiresAt: input.expiresAt,
      permissions: input.permissions,
    };
    const bodySha256 = await permissionBodySha256(unsigned);
    // The body (and so its hash) is the same on the retry; the invocation
    // is fresh for each attempt.
    const answer = await callService({
      service: 'hub',
      method: 'POST',
      url: `${this.origin}${PERMISSIONS_PATH}`,
      prepare: async () => {
        const invocation = await this.opts.mint([
          { method: 'POST', path: PERMISSIONS_PATH, body_sha256: bodySha256 },
        ]);
        return {
          headers: {
            'content-type': 'application/json',
            'x-channels-service-key': this.opts.serviceKey,
          },
          body: canonicalJson({ ...unsigned, invocation }),
        };
      },
      ...this.transport(),
    });
    const parsed = CardAnswer.safeParse(answer.body);
    if (!parsed.success) this.invalid();
    // The link the agent shares must be the Hub's own.
    if (!this.ownUrl(parsed.data.url)) this.invalid();
    return parsed.data;
  }

  /** The card's status and, per item, what was granted (grants only while allowed). */
  async status(id: string): Promise<PermissionState> {
    if (!OPAQUE_ID.test(id))
      throw new CredentialsServiceError({
        service: 'hub',
        status: 404,
        code: 'not_found',
      });
    const path = `${PERMISSIONS_PATH}/${id}`;
    const answer = await callService({
      service: 'hub',
      method: 'GET',
      url: `${this.origin}${path}`,
      prepare: async () => ({
        headers: {
          authorization: `Bearer ${await this.opts.mint([{ method: 'GET', path }])}`,
          'x-channels-service-key': this.opts.serviceKey,
        },
      }),
      ...this.transport(),
    });
    // Two steps: a valid card without `items` is a Hub from before the
    // one-card release, not a fault to retry.
    const card = CardStatus.safeParse(answer.body);
    if (!card.success || card.data.id !== id) this.invalid();
    if (!answer.body || !('items' in answer.body))
      throw new CredentialsServiceError({
        service: 'hub',
        status: 502,
        code: 'hub_update_needed',
      });
    const parsed = StatusAnswer.safeParse(answer.body);
    if (!parsed.success) this.invalid();
    return parsed.data;
  }

  /**
   * The person's live cards at this oracle, newest first: waiting ones and
   * allowed ones with something still running. The query string is built
   * once and is the same in the request and in the invocation's `path` fact.
   * A card this version cannot read is left out, never a failure.
   */
  async listPermissions(binding: {
    bindingId: string;
    bindingRevision: number;
  }): Promise<ListedPermission[]> {
    const query = new URLSearchParams({
      bindingId: binding.bindingId,
      bindingRevision: String(binding.bindingRevision),
    }).toString();
    const path = `${PERMISSIONS_PATH}?${query}`;
    const answer = await callService({
      service: 'hub',
      method: 'GET',
      url: `${this.origin}${path}`,
      prepare: async () => ({
        headers: {
          authorization: `Bearer ${await this.opts.mint([{ method: 'GET', path }])}`,
          'x-channels-service-key': this.opts.serviceKey,
        },
      }),
      ...this.transport(),
    });
    const parsed = ListAnswer.safeParse(answer.body);
    if (!parsed.success) this.invalid();
    const cards: ListedPermission[] = [];
    for (const raw of parsed.data.permissions.slice(
      0,
      MAX_LISTED_PERMISSIONS,
    )) {
      const card = ListedCard.safeParse(raw);
      if (!card.success) continue;
      const { url, ...rest } = card.data;
      // A link the agent may share must be the Hub's own.
      cards.push(url && this.ownUrl(url) ? { ...rest, url } : rest);
    }
    return cards;
  }

  private ownUrl(value: string): boolean {
    const url = new URL(value);
    return url.origin === this.origin && !url.username && !url.password;
  }

  private transport() {
    return {
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
      ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
      ...(this.opts.deadline !== undefined
        ? { deadline: this.opts.deadline }
        : {}),
      ...(this.opts.now ? { now: this.opts.now } : {}),
    };
  }
}
