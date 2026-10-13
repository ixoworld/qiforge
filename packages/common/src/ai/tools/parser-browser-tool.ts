import { type IRunnableConfigWithRequiredFields } from '@ixo/matrix';
import { tool } from '@langchain/core/tools';
import { summarizeFrontendResult } from '../frontend-bridge/index.js';
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

      let invocationId: string | undefined;
      const result = await callBrowserTool({
        sessionId,
        toolName,
        args: input as Record<string, unknown>,
        toolCallId: `tc-${requestId}`,
        onInvocation: (id) => {
          invocationId = id;
        },
      });

      if (configs?.matrix.roomId) {
        // The action log is diagnostic: identifiers and status only, never
        // the arguments or the result body (they carry user content).
        void logActionToMatrix(
          {
            name: toolName,
            args: {},
            ...summarizeFrontendResult(result, invocationId),
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
