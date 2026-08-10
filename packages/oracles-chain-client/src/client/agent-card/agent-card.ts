import { type LinkedResource } from '@ixo/impactxclient-sdk/codegen/ixo/iid/v1beta1/types';
import {
  fetchLinkedResourceDoc,
  findLinkedResource,
} from '../../utils/get-settings-resouce.js';
import { AgentCardSchema, type TResolvedAgentCard } from './types.js';

/** The LinkedResource that anchors an oracle's Agent Card on its entity. */
const AGENT_CARD_RESOURCE_TYPE = 'agentCard';
const AGENT_CARD_RESOURCE_ID_SUFFIX = '#acard';

const isAgentCardResource = (resource: LinkedResource): boolean =>
  resource.type === AGENT_CARD_RESOURCE_TYPE &&
  Boolean(resource.id?.endsWith(AGENT_CARD_RESOURCE_ID_SUFFIX));

/**
 * Resolve an oracle's Agent Card — the services it offers and what each costs.
 *
 * `null` is the normal "this oracle has not published a card" answer, and it is
 * also what an unreachable or malformed card resolves to: a caller deciding
 * which contracting UI to show must never be blocked by a transport blip on a
 * document it only needs in order to render. Callers that must distinguish
 * "absent" from "broken" should read the card resource directly.
 *
 * The card is the successor to the legacy `#fee` pricing list
 * (`Payments.getOraclePricingList`). An oracle may publish either, both, or —
 * during the transition — neither, so treat both as optional and never let one
 * gate the other.
 */
export async function getOracleAgentCard(
  oracleDid: string,
  matrixAccessToken?: string,
  matrixHomeServer?: string,
): Promise<TResolvedAgentCard | null> {
  try {
    const resource = await findLinkedResource(oracleDid, isAgentCardResource);
    if (!resource?.serviceEndpoint) return null;

    const raw = await fetchLinkedResourceDoc<unknown>(
      resource,
      matrixAccessToken,
      matrixHomeServer,
    );

    const parsed = AgentCardSchema.safeParse(raw);
    if (!parsed.success) return null;
    // The card has to be ABOUT the entity it is anchored on, or it is somebody
    // else's card sitting on this entity — not something to price work against.
    if (parsed.data.credentialSubject.id !== oracleDid) return null;

    return {
      oracleDid,
      card: parsed.data,
      cardProof: resource.proof || '',
    };
  } catch {
    return null;
  }
}
