import { tool } from '@langchain/core/tools';
import { Logger } from '@nestjs/common';
import type { MatrixClient } from 'matrix-js-sdk';
import { z } from 'zod';

import type { RuntimeContext } from '../../plugin-api/types.js';

import { readDelegations } from './blocknote-helper.js';
import { type AppConfig, MatrixProviderManager } from './provider.js';

const logger = new Logger('mint_invocation');

/**
 * Minimal UCAN surface the tool depends on. Decoupled from the concrete
 * `UcanService` class so the editor plugin can pass `rtCtx.ucan` directly
 * (the runtime adapter exposes exactly these methods).
 */
export interface UcanMintCapable {
  hasSigningKey(): boolean;
  createInvocationFromDelegation: RuntimeContext['ucan']['createInvocationFromDelegation'];
}

/** Same narrow shape for the blob store, taken from `rtCtx.blobStore`. */
export type BlobStoreCapable = Pick<RuntimeContext['blobStore'], 'put'>;

export interface CreateMintInvocationEditorToolParams {
  matrixClient: MatrixClient;
  appConfig: AppConfig;
  roomId: string;
  ucanService: UcanMintCapable;
  /** When provided alongside `userDid`, the minted invocation is stored in
   * the blob store and the tool result includes a `blobId` the main agent
   * can pass to `sandbox_write_blob` — avoiding LLM relay of the CAR. */
  blobStore?: BlobStoreCapable;
  /** Owner of the blob — used as the cache namespace. Required for blob
   * storage; without it the tool falls back to returning only the raw CAR. */
  userDid?: string;
}

/**
 * Editor-scoped `mint_invocation` tool.
 *
 * Lives on the editor agent (not the main agent) because minting requires
 * Y.Doc access via Matrix to fetch the user's delegation by CID — and the
 * editor agent is the only one with `matrixClient` + `roomId` in its
 * closure. The main agent invokes it through `call_editor_agent`.
 *
 * Two input modes — at least one must be provided:
 *
 *   1. `delegationCid` (preferred). The tool opens the flow's Y.Doc, looks
 *      up the delegation entry by CID, and reads its `delegation` field
 *      (the base64 CAR) directly. The 580-char base64 string never leaves
 *      this process and never crosses the LLM, so it can't be corrupted in
 *      transit.
 *
 *   2. `delegationCar` (legacy / external callers). Pass the base64 CAR
 *      directly — used when the caller already has the bytes in hand and
 *      doesn't want a Y.Doc lookup.
 *
 * Either way, the tool calls `ucanService.createInvocationFromDelegation`
 * and returns a fresh single-use base64 CAR invocation that the caller
 * (typically a sandbox skill) writes to its expected token file.
 */
export const createMintInvocationEditorTool = ({
  matrixClient,
  appConfig,
  // roomId is part of the shared tool-factory contract but not used by
  // this specific tool — minting only needs the userDid, ucanService and
  // the delegation source (cid via blobStore, or inline CAR). Prefixed
  // with `_` so the unused-vars rule lets it through.
  roomId: _roomId,
  ucanService,
  blobStore,
  userDid,
}: CreateMintInvocationEditorToolParams) =>
  tool(
    async ({
      delegationCid = null,
      delegationCar = null,
      serviceUrl,
      can,
      withResource,
    }) => {
      logger.log(
        `🪙 mint_invocation invoked (service=${serviceUrl}, can=${can}, with=${withResource}, mode=${delegationCid ? 'cid' : 'car'})`,
      );

      if (!ucanService.hasSigningKey()) {
        return JSON.stringify({
          success: false,
          error:
            'Oracle has no UCAN signing key configured. Check SERVICE_ED25519_MNEMONIC.',
        });
      }

      let resolvedCar: string | null = null;

      if (delegationCid && typeof delegationCid === 'string') {
        // Preferred path: look up the delegation in this flow's Y.Doc by CID.
        // No string ever crosses the LLM, so corruption-in-relay is impossible.
        const providerManager = new MatrixProviderManager(
          matrixClient,
          appConfig,
        );
        try {
          const { doc } = await providerManager.init();
          const { delegations } = readDelegations(doc);
          const match = delegations.find((d) => d['cid'] === delegationCid);
          if (!match) {
            return JSON.stringify({
              success: false,
              error: `Delegation with cid "${delegationCid}" not found in this flow's permissions store. The user may not have signed it yet, or Matrix sync has not delivered it to the oracle. Re-check the cid in the companion prompt and confirm the delegation exists via read_permissions.`,
            });
          }
          const car = match['delegation'];
          if (typeof car !== 'string' || !car) {
            return JSON.stringify({
              success: false,
              error: `Delegation entry for cid "${delegationCid}" has no \`delegation\` (base64 CAR) field. Stored entry shape may be legacy/unsupported.`,
            });
          }
          resolvedCar = car.trim();
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: `Failed to read delegation by cid: ${error instanceof Error ? error.message : String(error)}`,
          });
        } finally {
          await providerManager.dispose();
        }
      } else if (delegationCar && typeof delegationCar === 'string') {
        resolvedCar = delegationCar.trim();
      } else {
        return JSON.stringify({
          success: false,
          error:
            'Either `delegationCid` (preferred — the tool will look up the CAR from the Y.Doc) or `delegationCar` (the base64 CAR string directly) must be provided.',
        });
      }

      try {
        const result = await ucanService.createInvocationFromDelegation(
          resolvedCar,
          serviceUrl,
          { can, with: withResource },
        );

        if ('error' in result) {
          return JSON.stringify({ success: false, error: result.error });
        }

        // Store the freshly-minted invocation in the blob store so the main
        // agent can write it to the sandbox via `sandbox_write_blob` without
        // ever relaying the long base64 CAR through the LLM. The CAR is
        // STILL returned as `invocation` for back-compat / debugging — the
        // recommended path is for callers to use `blobId`.
        let blobId: string | undefined;
        if (blobStore && userDid) {
          try {
            // TTL = invocation lifetime + 30s headroom for sandbox write.
            // 90s default is enough since the worker rejects expired tokens
            // immediately and replay protection makes a longer window pointless.
            blobId = await blobStore.put({
              userDid,
              name: 'ucan_invocation',
              value: result.invocation,
              ttlSeconds: 90,
            });
          } catch (err) {
            logger.warn(
              `🪙 failed to store invocation in blob store: ${err instanceof Error ? err.message : String(err)} — caller will need to relay CAR directly`,
            );
          }
        }

        return JSON.stringify({
          success: true,
          ...(blobId ? { blobId } : {}),
          invocation: result.invocation,
          audienceResolvedFrom: serviceUrl,
          capability: { can, with: withResource },
          note: blobId
            ? 'Single-use. Pass `blobId` to `sandbox_write_blob` (preferred — keeps the CAR out of the LLM context). The `invocation` field is the same value verbatim if you must handle it directly. Mint a fresh invocation before each protected call.'
            : 'Single-use. Mint a fresh invocation before each protected service call.',
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    {
      name: 'mint_invocation',
      description: `Mint a fresh, single-use UCAN invocation against any UCAN-gated service, using a delegation the user already signed in the editor.

USE THIS TOOL whenever a skill needs to authenticate against an external service that requires a UCAN bearer token. Each invocation is single-use; mint a fresh one before every protected request (services typically reject reused invocation CIDs as replays).

WORKFLOW (preferred — \`delegationCid\` mode):
1. The companion prompt provides a \`delegationCid\` (the user's signed delegation to this oracle) and a \`serviceUrl\` (the target service's base URL).
2. Call this tool with the cid + serviceUrl + the route's required capability \`{ can, with }\`. The tool itself reads the CAR from the flow's Y.Doc — you do NOT need to call \`read_permissions\` first.
3. It returns \`{ success, blobId, invocation, ... }\`. **Use \`blobId\` — pass it to \`sandbox_write_blob\` to write the invocation to the skill's token path.** That way the long base64 CAR never enters the LLM context where it can get corrupted. The \`invocation\` field is the same value verbatim and only there for back-compat / debugging.
4. Run the protected command in the sandbox.

LEGACY (\`delegationCar\` mode): if you already have the base64 CAR string in hand from somewhere else, you can pass it directly via \`delegationCar\`. NOT recommended — long base64 strings can get mangled when an LLM relays them.

The audience is auto-resolved by fetching \`<serviceUrl>/.well-known/did.json\`. The invocation is signed by THIS oracle's key, with the user's delegation embedded as proof. Service validators walk the chain back to the user (the root issuer) and accept the call iff the user is on their root-issuers allowlist.

Returns:
  { success: true, invocation: "<base64 CAR>", capability, audienceResolvedFrom }
or
  { success: false, error: "<reason>" } — surface the error verbatim if it indicates a setup problem (missing/expired delegation, audience mismatch, did:web unreachable, signing key not configured).`,
      schema: z.object({
        delegationCid: z
          .string()
          .optional()
          .nullable()
          .describe(
            'PREFERRED. The CID of a UCAN delegation stored in this flow. The tool looks up the base64 CAR from the Y.Doc itself, so you only ever pass a short ~59-char CID — no risk of string corruption. Use the value from the companion prompt\'s "UCAN delegation CID:" field.',
          ),
        delegationCar: z
          .string()
          .optional()
          .nullable()
          .describe(
            "LEGACY. The base64-encoded delegation CAR string. Only use this when you cannot use delegationCid (e.g. the delegation lives outside the flow's Y.Doc). Long strings are vulnerable to LLM relay corruption — prefer delegationCid.",
          ),
        serviceUrl: z
          .string()
          .url()
          .describe(
            'Base URL of the target service (used to resolve did:web). Use the URL from the companion prompt verbatim — do NOT swap to a default or guess.',
          ),
        can: z
          .string()
          .describe(
            'The capability action the route requires, e.g. "service/action" or "service/*". Defined by the target service; check SKILL.md or service docs.',
          ),
        withResource: z
          .string()
          .describe(
            'The capability resource URI, e.g. "ixo:my-service". Defined by the target service.',
          ),
      }),
    },
  );
