import type { RuntimeContext } from '../../plugin-api/types';
import { FlowError } from './errors';
import { withFlowDoc } from './flow-doc';
import { readFlowSpec } from './read';
import type { FlowSpecRead } from './types';

export async function readFlowDecisionContext(
  ctx: RuntimeContext,
  ref?: string,
): Promise<FlowSpecRead> {
  ctx.abortSignal.throwIfAborted();
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
