import { z } from 'zod';
import { CredentialsServiceError } from './errors';
import { callService, type FetchLike } from './http';
import { canonicalJson, jsonBodySha256 } from './hub-client';
import { SelfTime } from './times';

/**
 * Self (the identity oracle): identity-check links for a person.
 *
 * The oracle calls as itself, proved by the person's delegation to it
 * (`identity/link` on `ixo:identity`, granted on the Hub's "use a service"
 * card): every call is a fresh UCAN invocation from that delegation to
 * Self's did:web, bound by a `{ method, path }` fact (the full
 * `/identity/v1/…` path), in `Authorization: Bearer`. A second fact,
 * `{ entityDid }`, names the oracle's entity: Self trusts it only when the
 * entity's `#orz` names the oracle's account, and shows the person the
 * entity's IXO Names name as who is asking (a short id without it).
 */

export const LINKS_PATH = '/identity/v1/links';
export const LINK_CAPABILITY = {
  can: 'identity/link',
  with: 'ixo:identity',
} as const;

export const LINK_STATUSES = [
  'sent',
  'opened',
  'in_progress',
  'passed',
  'failed',
  'expired',
  'cancelled',
] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

const LINK_ID = /^[A-Za-z0-9_-]{1,128}$/;

// Self answers its times as ISO 8601 text; they are Unix seconds from here on.
const CreatedLink = z.object({
  linkId: z.string().regex(LINK_ID),
  url: z.string().url(),
  expiresAt: SelfTime,
});
export type CreatedLink = z.infer<typeof CreatedLink>;

/**
 * Self's `review: true` beside `status: "in_progress"`: the check waits for
 * a person to review it. Read leniently: absent, any other value, or any
 * other status is "not in review" (an older Self never sends it), and it is
 * kept only as `true`.
 */
const Review = z.literal(true).optional().catch(undefined);

/**
 * Self's `saving: true` beside `status: "in_progress"`: the check passed and
 * the proof is still being saved to the person's IXO account. Read as
 * leniently as `review`.
 */
const Saving = z.literal(true).optional().catch(undefined);

const LinkState = z
  .object({
    linkId: z.string().regex(LINK_ID),
    status: z.enum(LINK_STATUSES),
    updatedAt: SelfTime,
    expiresAt: SelfTime,
    review: Review,
    saving: Saving,
  })
  .transform(({ review, saving, ...state }) => ({
    ...state,
    ...(review && state.status === 'in_progress' ? { review } : {}),
    ...(saving && state.status === 'in_progress' ? { saving } : {}),
  }));
export type LinkState = z.infer<typeof LinkState>;

/** Mints one invocation from the person's link delegation, bound by `facts`. */
export type MintFromDelegation = (
  facts: Record<string, unknown>[],
) => Promise<string>;

export interface SelfLinksClientOptions {
  /** Self's API origin. */
  selfUrl: string;
  /** The origin of the person's links (Self's web app): a link must be on it. */
  webOrigin: string;
  /** The oracle's entity DID, sent as the `{ entityDid }` fact. */
  entityDid?: string;
  mint: MintFromDelegation;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** The tool's deadline (unix ms), see `ServiceCall.deadline`. */
  deadline?: number;
  now?: () => number;
}

export class SelfLinksClient {
  private readonly origin: string;

  constructor(private readonly opts: SelfLinksClientOptions) {
    this.origin = new URL(opts.selfUrl).origin;
  }

  /**
   * The facts of one call: the request binding (with `body_sha256` for a
   * body), then the oracle's entity.
   */
  private facts(method: 'GET' | 'POST', path: string, bodySha256?: string) {
    return [
      bodySha256 ? { method, path, body_sha256: bodySha256 } : { method, path },
      ...(this.opts.entityDid ? [{ entityDid: this.opts.entityDid }] : []),
    ];
  }

  private invalid(): never {
    throw new CredentialsServiceError({
      service: 'self',
      status: 502,
      code: 'invalid_response',
    });
  }

  /**
   * One open link for the person. `offerConsent` is the person's delegation
   * to Self's issuer DID (`credentials/offer`), which Self keeps so it can
   * offer the credential when the check passes.
   */
  async createLink(input: {
    offerConsent: string;
    requestKey: string;
  }): Promise<CreatedLink> {
    const json = {
      offerConsent: input.offerConsent,
      requestKey: input.requestKey,
    };
    const bodySha256 = await jsonBodySha256(json);
    const answer = await callService({
      service: 'self',
      method: 'POST',
      url: `${this.origin}${LINKS_PATH}`,
      prepare: async () => ({
        headers: {
          authorization: `Bearer ${await this.opts.mint(this.facts('POST', LINKS_PATH, bodySha256))}`,
          'content-type': 'application/json',
        },
        body: canonicalJson(json),
      }),
      ...this.transport(),
    });
    const parsed = CreatedLink.safeParse(answer.body);
    if (!parsed.success) this.invalid();
    // The link the agent shares must be Self's own.
    const url = new URL(parsed.data.url);
    if (
      url.origin !== new URL(this.opts.webOrigin).origin ||
      url.username ||
      url.password
    )
      this.invalid();
    return parsed.data;
  }

  /** A link's status only; Self never answers personal data here. */
  async linkStatus(linkId: string): Promise<LinkState> {
    if (!LINK_ID.test(linkId))
      throw new CredentialsServiceError({
        service: 'self',
        status: 404,
        code: 'not_found',
      });
    const path = `${LINKS_PATH}/${linkId}`;
    const answer = await callService({
      service: 'self',
      method: 'GET',
      url: `${this.origin}${path}`,
      prepare: async () => ({
        headers: {
          authorization: `Bearer ${await this.opts.mint(this.facts('GET', path))}`,
        },
      }),
      ...this.transport(),
    });
    const parsed = LinkState.safeParse(answer.body);
    if (!parsed.success || parsed.data.linkId !== linkId) this.invalid();
    return parsed.data;
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
