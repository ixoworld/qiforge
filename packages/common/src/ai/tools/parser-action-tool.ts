import { type IRunnableConfigWithRequiredFields } from '@ixo/matrix';
import { tool } from '@langchain/core/tools';
import { randomUUID } from 'node:crypto';
import { summarizeFrontendResult } from '../frontend-bridge/index.js';
import { callAgAction } from './action-caller.js';
import { logActionToMatrix } from './log-action-to-matrix.js';

interface IParseAgActionParams {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

// Helper function to parse AG-UI action into LangChain tool
export function parserActionTool(action: IParseAgActionParams) {
  const { name, description, schema } = action;
  return tool(
    async (input, runnableConfig) => {
      const { configurable } =
        runnableConfig as IRunnableConfigWithRequiredFields;
      // Prefer explicit `sessionId` — sub-agent wrappers set this to the real
      // user WS session so routing works from nested contexts. Fall back to
      // `thread_id` for direct invocations from the main agent (where
      // thread_id IS the user's session).
      const sessionIdField = (configurable as { sessionId?: unknown })
        .sessionId;
      const sessionId =
        typeof sessionIdField === 'string' && sessionIdField.length > 0
          ? sessionIdField
          : configurable.thread_id;
      const { requestId, configs } = configurable;

      if (!sessionId) {
        throw new Error('sessionId is required for AG-UI actions');
      }

      // Unique toolCallId per invocation. Protects against:
      //  - Multiple tool calls sharing one requestId (React key collisions)
      //  - Any future code path that forgets to propagate requestId
      const toolCallId = `ag_${requestId ?? 'noreq'}_${randomUUID().slice(0, 8)}`;

      // Call the action and WAIT for result from frontend
      let invocationId: string | undefined;
      const result = await callAgAction({
        sessionId,
        toolCallId,
        toolName: name,
        args: input as Record<string, unknown>,
        timeout: 15000, // 15 seconds
        onInvocation: (id) => {
          invocationId = id;
        },
      });

      if (configs?.matrix.roomId) {
        // The action log is diagnostic: identifiers and status only, never
        // the arguments or the result body (they carry user content).
        void logActionToMatrix(
          {
            name,
            args: {},
            ...summarizeFrontendResult(result, invocationId),
          },
          {
            roomId: configs.matrix.roomId,
            threadId: sessionId,
          },
        );
      }

      // Return the actual result from frontend
      return JSON.stringify(result);
    },
    {
      name,
      description,
      schema,
      metadata: {
        actionTool: true,
      },
    },
  );
}
