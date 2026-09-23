import { type IRunnableConfigWithRequiredFields } from '@ixo/matrix';
import { tool } from '@langchain/core/tools';
import { callBrowserTool } from './browser-tool-caller.js';
import { logActionToMatrix } from './log-action-to-matrix.js';

interface IParserBrowserToolParams {
  description: string;
  schema: Record<string, unknown>;
  toolName: string;
}

export function parserBrowserTool(params: IParserBrowserToolParams) {
  const { description, schema, toolName } = params;
  return tool(
    async (input, runnablesConfig) => {
      const {
        configurable: { thread_id: sessionId, requestId, configs },
      } = runnablesConfig as IRunnableConfigWithRequiredFields;
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const result = await callBrowserTool({
        sessionId,
        toolName,
        args: input as Record<string, unknown>,
        toolCallId: `tc-${requestId}`,
      });

      if (configs?.matrix.roomId) {
        void logActionToMatrix(
          {
            name: toolName,
            args: {},
            result: { requestId },
            success: !(
              typeof result === 'object' &&
              result !== null &&
              'success' in result &&
              result.success === false
            ),
          },
          {
            roomId: configs.matrix.roomId,
            threadId: sessionId,
          },
        );
      }
      return result;
    },
    {
      name: toolName,
      description,
      schema,
      metadata: {
        browserTool: true,
      },
    },
  );
}
