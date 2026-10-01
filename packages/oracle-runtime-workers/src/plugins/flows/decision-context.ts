import type { RuntimeContext } from '../../plugin-api/types';
import { FlowError } from './errors';
import type { FlowSpecRead } from './types';

/**
 * This module is re-exported from the plugin index, which the Worker
 * evaluates at module scope. `flow-doc` and `read` reach `@ixo/editor` →
 * `@ixo/matrix-crdt` → vscode-lib, which schedules a timer while it is
 * evaluated — forbidden in workerd's global scope (see `flows.plugin.ts`) —
 * so both are loaded on the first call, inside a request context.
 */
export async function readFlowDecisionContext(
  ctx: RuntimeContext,
  ref?: string,
): Promise<FlowSpecRead> {
  ctx.abortSignal.throwIfAborted();
  const [{ withFlowDoc }, { readFlowSpec }] = await Promise.all([
    import('./flow-doc'),
    import('./read'),
  ]);
  return withFlowDoc(ctx, ref, undefined, async (doc, roomId) => {
    ctx.abortSignal.throwIfAborted();
    const flow = readFlowSpec(doc, roomId);
    if (!flow)
      throw new FlowError(
        'flow_not_found',
        'That flow does not exist or has no steps yet.',
      );
    return flow;
  });
}
