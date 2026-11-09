import { OraclePlugin, type PluginEnv } from '../../plugin-api/oracle-plugin';
import type {
  AuthExcludedRoute,
  PluginContext,
  PluginManifest,
  PluginTool,
} from '../../plugin-api/types';
import type { PluginRoute } from '../../shell/app';
import { credentialsConfigSchema, resolveCredentialsConfig } from './config';
import { VerifierEntryMemo } from './credentials-client';
import { createCredentialsTools } from './credentials-tools';
import type { FetchLike } from './http';
import {
  credentialsResponseRoute,
  RESPONSE_ROUTE_PATH,
  type DeliverToOwner,
} from './response-route';
import { VerifierContext } from './verifier';

const IDENTITY_VCT = 'https://credentials.ixo.world/types/IdentityLevel1';

const manifest: PluginManifest = {
  title: 'Credentials and permissions',
  summary:
    "Check the person's verifiable credentials (age, verified identity or any other credential type and issuer) through their IXO wallet, and ask their permission, on a card in the wallet, to check a credential or to use a catalogued service for them (an identity check by Self). WhatsApp chat only for now.",
  category: 'auth',
  visibility: 'on-demand',
  brief: 'check credentials; ask permission on a wallet card',
  whenToUse: [
    'You need proof of something about the person (that they are over 18, that they passed an identity check, a membership or another credential) before you go on.',
    'The person should allow you, once, to check a credential without being asked every time: request a check permission.',
    'The person needs an identity check and has no identity credential yet: ask permission for "self.identity-check", then send them the link Self creates.',
    'You sent a permission card or an identity-check link and need to know how it went.',
  ],
  whenNotToUse: [
    "Outside our WhatsApp chat: every tool refuses there; tell the person it isn't available here yet.",
    'To read or store files, notes or anything the person tells you: that is not a credential.',
    'To ask for more fields than the task needs: ask for the fewest (for age, age_over_18, never the birth date).',
  ],
  examples: [
    {
      user: 'I want to claim the reward',
      thought:
        'The reward needs proof they are over 18. Try the check; a pending result means no standing permission.',
      tool: 'credentials_check',
      args: {
        vct: IDENTITY_VCT,
        claims: ['age_over_18'],
      },
    },
    {
      user: 'Sure, you can check my age whenever you need to',
      thought: 'Ask once for standing permission; send the link.',
      tool: 'credentials_request_check_permission',
      args: {
        vct: IDENTITY_VCT,
        claims: ['age_over_18'],
        days: 30,
      },
    },
    {
      user: "I don't have an ID credential yet",
      thought:
        'Ask permission for the identity check, then create the link once they allow it.',
      tool: 'credentials_request_action_permission',
      args: { action: 'self.identity-check', days: 7 },
    },
  ],
};

const operatingGuide = `### Credentials and permissions

- These tools work only in our WhatsApp chat. Anywhere else, say plainly that it is not available here yet.
- Every link (a permission card, the wallet, an identity-check link) goes to the person as ONE link in a short message. Each tool's \`message\` is ready to send. Never paste ids, tokens, DIDs or codes.
- The person sees only two kinds of card: "check a credential" (who asks, the credential, its issuer, the fields you will see, how long) and "use a service for you" (who asks, the action, the service, what it allows, how long). Do not describe anything else.
- Ask for the fewest fields the task needs. The issuers accepted per credential type are configured by the operator: leave \`issuers\` out, or narrow them; anything else is refused.
- \`credentials_check\` returns \`pending\` when no standing permission answered: send the wallet link, or ask for standing permission with \`credentials_request_check_permission\`. Call it again with the same fields to continue the same request.
- For an identity check: \`credentials_request_action_permission\` (self.identity-check), wait until they allow it, then \`credentials_request_action\` for the link; \`credentials_action_status\` reads its progress.
- Use the claims of a valid check for the task at hand only; never repeat them back beyond what the conversation needs.`;

/** Optional dependency injection, for tests. */
export interface CredentialsPluginOptions {
  fetchImpl?: FetchLike;
  /** The fetch the kit's DID and status-list reads use. */
  kitFetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  checkWaitMs?: number;
  deliver?: DeliverToOwner;
}

/**
 * Credentials plugin.
 *
 * Six tools for any credential type and issuer, plus the catalogued service
 * actions: ask the person's permission on one of the Hub's two fixed cards
 * (`credentials_request_check_permission`,
 * `credentials_request_action_permission`) and read the answer
 * (`credentials_permission_status`); check a credential as a verifier at
 * the Credentials worker (`credentials_check`); carry out an allowed action
 * at Self (`credentials_request_action`, `credentials_action_status`).
 *
 * WhatsApp only: every tool refuses unless the turn came from our WhatsApp
 * channel (`whatsAppBinding`). Off unless `CREDENTIALS_ENABLED=true`; the
 * tools also need the oracle's signing key and the Hub key
 * (`AUTH_HUB_CHANNEL_SERVICE_KEY`), and `credentials_check` needs
 * `ORACLE_PUBLIC_URL` (its response endpoint, `POST
 * /credentials/response/:token`, is this plugin's one route).
 */
export class CredentialsPlugin extends OraclePlugin {
  readonly name = 'credentials';

  readonly version = '0.1.0';

  readonly manifest = manifest;

  override readonly operatingGuide = operatingGuide;

  override readonly configSchema = credentialsConfigSchema;

  override readonly autoDetectHint =
    'CREDENTIALS_ENABLED=true and AUTH_HUB_CHANNEL_SERVICE_KEY';

  private readonly memo = new VerifierEntryMemo();

  private verifier: { key: string; context: VerifierContext } | null = null;

  constructor(private readonly options: CredentialsPluginOptions = {}) {
    super();
  }

  override autoDetect(env: PluginEnv): boolean {
    return (
      env.CREDENTIALS_ENABLED === 'true' &&
      typeof env.AUTH_HUB_CHANNEL_SERVICE_KEY === 'string' &&
      env.AUTH_HUB_CHANNEL_SERVICE_KEY.length > 0
    );
  }

  /** One verifier context per isolate (DID and status-list caches). */
  private verifierFor(
    blocksyncUrl: string | undefined,
    allowLocal: boolean,
  ): VerifierContext | null {
    if (!blocksyncUrl) return null;
    const key = `${blocksyncUrl}|${allowLocal}`;
    if (this.verifier?.key !== key)
      this.verifier = {
        key,
        context: new VerifierContext(
          blocksyncUrl,
          allowLocal,
          this.options.kitFetch,
        ),
      };
    return this.verifier.context;
  }

  override getTools(ctx: PluginContext): PluginTool[] {
    const cfg = resolveCredentialsConfig(ctx.config);
    if (!cfg.enabled) return [];
    return createCredentialsTools({
      cfg,
      oracle: {
        name: ctx.identity.name,
        ...(ctx.identity.description
          ? { description: ctx.identity.description }
          : {}),
      },
      verifier: this.verifierFor(cfg.blocksyncUrl, cfg.allowLocal),
      memo: this.memo,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.checkWaitMs !== undefined
        ? { checkWaitMs: this.options.checkWaitMs }
        : {}),
    });
  }

  override getRoutes(): PluginRoute[] {
    return [credentialsResponseRoute(this.options.deliver)];
  }

  override getAuthExcludedRoutes(): AuthExcludedRoute[] {
    // The wallet answers here without a UCAN: the sealed token in the path
    // and the encrypted answer authenticate it.
    return [{ path: RESPONSE_ROUTE_PATH, method: 'POST' }];
  }
}
