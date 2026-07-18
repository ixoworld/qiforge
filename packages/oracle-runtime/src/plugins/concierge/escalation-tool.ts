import { MatrixManager } from '@ixo/matrix';
import {
  getMatrixHomeServerCroppedForDid,
  getSupportAccounts,
  getSupportRoomAlias,
} from '@ixo/oracles-chain-client';
import { z } from 'zod';
import { didToMatrixUserId } from '../../matrix/user-id.js';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool } from '../../plugin-api/types.js';

const schema = z.object({
  summary: z
    .string()
    .min(1, 'summary is required')
    .describe(
      'Concise handoff summary for the human: who the visitor is (as far as known), what they need, and what has been tried. They read this before opening the conversation — make it self-contained.',
    ),
  urgency: z
    .enum(['low', 'normal', 'high'])
    .optional()
    .describe(
      'How urgent this feels: high = user is blocked/upset or something looks broken; low = curiosity that can wait. Default normal.',
    ),
});

const DESCRIPTION = `Notify this oracle's designated human support team about the current conversation. Posts an @mention notification (with your summary and a link back to this conversation) into the entity's Support room — the mention triggers a push notification on the support members' devices.

Call it when the visitor asks for a human, reports a problem you cannot resolve, seems stuck or frustrated, or when a question matters and you cannot answer it from the domain card or documentation.

The support contacts come from this oracle's entity DID document. If none are configured (or the Support room is unreachable), the tool says so — relay that honestly instead of promising contact.`;

export interface CreateEscalationToolDeps {
  /** This oracle's entity DID (`identity.entityDid`). */
  entityDid: string;
  /** Display name used in the escalation message header. */
  oracleName: string;
}

/**
 * `escalate_to_support` — resolve the designated support accounts from the
 * entity's DID document, join the entity's Support room, and post an
 * intentional-mention notification there. Never throws: every failure path
 * returns an agent-relayable message.
 */
export function createEscalationTool({
  entityDid,
  oracleName,
}: CreateEscalationToolDeps): PluginTool {
  return tool(
    async (rawArgs, rtCtx) => {
      const { summary, urgency } = schema.parse(rawArgs);

      let accounts;
      try {
        accounts = await getSupportAccounts(entityDid);
      } catch (error) {
        rtCtx.logger.warn(
          `[concierge] support lookup failed for ${entityDid}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 'Could not look up the support team right now (the registry query failed). Apologize and suggest the visitor tries again shortly.';
      }
      if (accounts.length === 0) {
        return 'No human support contacts are configured for this oracle (no linkedEntity with relationship "support" and service "matrix" on its DID document). Be honest that direct human support is not available yet.';
      }

      const manager = MatrixManager.getInstance();
      const fallbackHomeserver = manager.getHomeserverName();
      const homeserverFor = (did: string): Promise<string> =>
        getMatrixHomeServerCroppedForDid(did).catch(() => fallbackHomeserver);

      const supportMatrixIds = await Promise.all(
        accounts.map(async (account) =>
          didToMatrixUserId(account.did, await homeserverFor(account.did)),
        ),
      );

      const supportRoomAlias = getSupportRoomAlias(
        entityDid,
        await homeserverFor(entityDid),
      );
      let supportRoomId: string;
      try {
        supportRoomId = await manager.joinRoom(supportRoomAlias);
      } catch (error) {
        rtCtx.logger.warn(
          `[concierge] could not join support room ${supportRoomAlias}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return `The support team could not be notified: the Support room (${supportRoomAlias}) is not reachable. Apologize and suggest the visitor tries again later.`;
      }

      const pills = supportMatrixIds
        .map((id) => `[${id}](https://matrix.to/#/${id})`)
        .join(' ');
      const conversationLink = rtCtx.session.roomId
        ? `[open the conversation](https://matrix.to/#/${encodeURIComponent(rtCtx.session.roomId)}/${encodeURIComponent(rtCtx.session.id)}?via=${fallbackHomeserver})`
        : 'conversation link unavailable';
      const requester = rtCtx.user.matrixUserId;

      const message = [
        `🛎️ **Support request** — ${oracleName}`,
        pills,
        `**From:** ${requester}`,
        `**Urgency:** ${urgency ?? 'normal'}`,
        `**Summary:** ${summary}`,
        `**Conversation:** ${conversationLink}`,
      ].join('\n\n');

      try {
        await manager.sendMessage({
          roomId: supportRoomId,
          message,
          isOracleAdmin: true,
          disablePrefix: true,
          mentions: supportMatrixIds,
        });
      } catch (error) {
        rtCtx.logger.warn(
          `[concierge] escalation post failed in ${supportRoomId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 'The support notification could not be delivered (posting to the Support room failed). Apologize and suggest the visitor tries again shortly.';
      }

      return `Notified ${supportMatrixIds.length} support member(s) in the Support room with your summary and a link to this conversation. Tell the visitor a human has been notified and will follow up — do not promise an exact response time.`;
    },
    {
      name: 'escalate_to_support',
      description: DESCRIPTION,
      schema,
    },
  );
}
