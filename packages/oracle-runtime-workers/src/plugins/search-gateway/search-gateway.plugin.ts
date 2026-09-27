import { z } from 'zod';
import { UCAN_STORE_DEFAULT_URLS } from '../../owner-store/ixo-vfs-store';
import { OraclePlugin } from '../../plugin-api/oracle-plugin';
import { tool as pluginTool } from '../../plugin-api/tool-helper';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';

/**
 * IXO Search Gateway endpoints per network; `SEARCH_GATEWAY_URL` overrides.
 */
export const SEARCH_GATEWAY_DEFAULT_URLS = {
  mainnet: 'https://search.ixo.earth',
  testnet: 'https://testnet.search.ixo.earth',
  devnet: 'https://devnet.search.ixo.earth',
} as const;

/** Where the `ixo-jev-search` capsule skill reads the Bearer value. */
export const SEARCH_AUTHORIZATION_SANDBOX_PATH =
  '/workspace/data/ixo-jev-search/authorization';

const configSchema = z.object({
  SEARCH_GATEWAY_URL: z.string().url().optional(),
});

const siblingEnvSchema = z.object({
  NETWORK: z.enum(['mainnet', 'testnet', 'devnet']).optional(),
  UCAN_STORE_URL: z.string().url().optional(),
});

const authorizeSchema = z.object({
  requestDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe(
      "The `mint.facts.rd` value printed by the skill's `prepare` command (64 lowercase hex).",
    ),
});

const DESCRIPTION = `Mint the single-use IXO Search Gateway authorization for ONE prepared search, without the credential ever entering the conversation.

Call after the ixo-jev-search skill's \`prepare\` command, passing its \`mint.facts.rd\` as \`requestDigest\`. The runtime signs a fresh \`search/authenticate\` invocation as this oracle (proved by the user's delegation, bound to that exact request by \`rd\`), appends the user's own gateway grants from the UCAN store, and stores the Bearer value as a blob.

Returns \`{ success: true, blobId, writeTo, grantCount }\`. Then call \`sandbox_write_blob({ blobId, path: writeTo })\` and run the skill's \`search\` command. One authorization per prepared request: after a new \`prepare\`, call this again.

Errors: the user has not delegated \`search/authenticate\` (or \`search/*\`) on \`ixo:search\` to this oracle, or has deposited no grants addressed to the gateway — relay that they need to authorize search in Portal.`;

const manifest: PluginManifest = {
  title: 'Search Gateway',
  summary:
    "Authorizes capsule-skill searches of the IXO Search Gateway on the user's behalf (Jev-ranked federated search over domains, the user's files, and the chain catalog).",
  whenToUse: [
    'The ixo-jev-search skill printed a `mint` object after `prepare` and needs its authorization written to the sandbox.',
  ],
  whenNotToUse: [
    'Anything other than authorizing a prepared ixo-jev-search request.',
  ],
  tags: ['ixo', 'search', 'ucan'],
  category: 'data',
  visibility: 'on-demand',
  stability: 'experimental',
};

export interface SearchGatewayPluginOptions {
  /** Test seam: invocation TTL is left to the runtime's mint (≤ 1 h). */
  readonly blobTtlSeconds?: number;
}

/**
 * Search Gateway plugin. One request-time tool, `search_gateway_authorize`:
 * delegated authentication for the IXO Search Gateway (its
 * `docs/authorization/http-envelope-v1.md`). The user's delegation to this
 * oracle must include `search/authenticate` (or `search/*`) on `ixo:search`;
 * the user's grants to the gateway are read from the UCAN store and must be
 * issued by the user and addressed to the gateway DID. Nothing here widens
 * the user's authority: the gateway only honours grants the user signed.
 */
export class SearchGatewayPlugin extends OraclePlugin {
  readonly name = 'search-gateway';

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override readonly configSchema = configSchema;

  private readonly options: SearchGatewayPluginOptions;

  constructor(options: SearchGatewayPluginOptions = {}) {
    super();
    this.options = options;
  }

  override getRequestTools(rtCtx: RuntimeContext): PluginTool[] {
    if (!rtCtx.ucan.hasSigningKey() || !rtCtx.user.did) return [];
    const own = configSchema.safeParse(rtCtx.config);
    const siblings = siblingEnvSchema.safeParse(rtCtx.config);
    const network = (siblings.success && siblings.data.NETWORK) || 'mainnet';
    const gatewayUrl =
      (own.success && own.data.SEARCH_GATEWAY_URL) ||
      SEARCH_GATEWAY_DEFAULT_URLS[network];
    const storeUrl =
      (siblings.success && siblings.data.UCAN_STORE_URL) ||
      UCAN_STORE_DEFAULT_URLS[network] ||
      'https://store.ucan.ixo.earth';
    return [
      createSearchGatewayAuthorizeTool({
        gatewayUrl,
        storeUrl,
        blobTtlSeconds: this.options.blobTtlSeconds ?? 300,
      }),
    ];
  }
}

export function createSearchGatewayAuthorizeTool(params: {
  gatewayUrl: string;
  storeUrl: string;
  blobTtlSeconds: number;
}): PluginTool {
  return pluginTool(
    async (rawArgs, ctx: RuntimeContext) => {
      const { requestDigest } = authorizeSchema.parse(rawArgs);
      const userDid = ctx.user.did;
      if (!userDid) {
        return JSON.stringify({
          success: false,
          error: 'No user DID for this turn.',
        });
      }
      const gatewayDid = await ctx.ucan.resolveServiceDid(params.gatewayUrl);
      if (!gatewayDid) {
        return JSON.stringify({
          success: false,
          error: `Could not resolve the gateway DID from ${params.gatewayUrl}/.well-known/did.json`,
        });
      }
      let invocation: string;
      try {
        invocation = await ctx.ucan.mintInvocation(
          { did: gatewayDid, capability: 'ixo:search' },
          {
            can: 'search/authenticate',
            facts: { iat: Math.floor(Date.now() / 1000), rd: requestDigest },
          },
        );
      } catch (err) {
        return JSON.stringify({
          success: false,
          error: `Could not mint the search authentication (the user must delegate search/authenticate on ixo:search to this oracle): ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      const grants = await ctx.ucan.listAudienceGrants(userDid, {
        storeUrl: params.storeUrl,
        audienceDid: gatewayDid,
      });
      if ('error' in grants) {
        return JSON.stringify({
          success: false,
          error: `Could not read the user's gateway grants from the UCAN store: ${grants.error}`,
        });
      }
      if (grants.tokens.length === 0) {
        return JSON.stringify({
          success: false,
          error:
            'The user has deposited no search grants addressed to the gateway; they need to authorize search in Portal.',
        });
      }
      const blobId = await ctx.blobStore.put({
        userDid,
        name: 'search-gateway-authorization',
        value: [invocation, ...grants.tokens].join('.'),
        ttlSeconds: params.blobTtlSeconds,
      });
      return JSON.stringify({
        success: true,
        blobId,
        writeTo: SEARCH_AUTHORIZATION_SANDBOX_PATH,
        audience: gatewayDid,
        grantCount: grants.tokens.length,
      });
    },
    {
      name: 'search_gateway_authorize',
      description: DESCRIPTION,
      schema: authorizeSchema,
    },
  );
}
