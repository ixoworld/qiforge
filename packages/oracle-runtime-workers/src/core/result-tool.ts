import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { ToolExecutionContext } from './tool-execution';

export function savedResultNotice(id: string): string {
  return `Large result saved as ${id}. Use read_harness_result with this id and an offset to read 4000 characters at a time.`;
}

export function createResultTool(execution: ToolExecutionContext) {
  return tool(
    async ({ id, offset }, config) => {
      execution.budget.reserveTool(execution.signal ?? config.signal);
      return (
        (await execution.store?.readResult(execution.sessionId, id, offset)) ??
        'Result not found in this session.'
      );
    },
    {
      name: 'read_harness_result',
      description:
        'Read a saved large tool result in 4000-character chunks. Increase offset by 4000 for the next chunk.',
      schema: z.object({
        id: z.string().regex(/^[a-f0-9]{64}$/),
        offset: z.number().int().nonnegative().default(0),
      }),
    },
  );
}
