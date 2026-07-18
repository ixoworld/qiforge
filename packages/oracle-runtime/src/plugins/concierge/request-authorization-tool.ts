import { MatrixManager } from '@ixo/matrix';
import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool } from '../../plugin-api/types.js';

const schema = z.object({});

const DESCRIPTION = `Send the authorization request into this Matrix room, so IXO Portal clients open the "authorize this oracle" flow for the user.

Call it ONLY when the user explicitly asks to authorize you, unlock full access, or upgrade from the concierge — never unprompted. After calling it, also explain the manual path: open this oracle in the IXO Portal and approve the authorization there (plain Matrix clients don't render the request).`;

export interface CreateRequestAuthorizationToolDeps {
  oracleEntityDid: string;
  oracleDid: string;
}

/**
 * `request_authorization` — emits the same `ixo.oracle.delegation_required`
 * event the runtime used to fire automatically on unauthorized Matrix turns.
 * In concierge mode that automatic nudge is suppressed; this tool turns it
 * into a deliberate act on user request.
 */
export function createRequestAuthorizationTool({
  oracleEntityDid,
  oracleDid,
}: CreateRequestAuthorizationToolDeps): PluginTool {
  return tool(
    async (_rawArgs, rtCtx) => {
      const roomId = rtCtx.session.roomId;
      if (!roomId) {
        return 'No Matrix room is attached to this session — walk the user through authorizing from the IXO Portal instead.';
      }

      await MatrixManager.getInstance().sendMatrixEvent(
        roomId,
        'ixo.oracle.delegation_required',
        {
          oracleEntityDid,
          oracleDid,
        },
      );

      return 'Authorization request sent to this room. Portal clients now show the authorize flow; also tell the user they can open this oracle in their IXO Portal and approve it there. Once authorized, their next message unlocks the full service.';
    },
    {
      name: 'request_authorization',
      description: DESCRIPTION,
      schema,
    },
  );
}
