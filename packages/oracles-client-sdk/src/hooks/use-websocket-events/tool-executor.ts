import type { Socket } from 'socket.io-client';
import { type IBrowserToolParams } from '../../types/browser-tool.type.js';

export interface ToolExecutionConfig {
  socket: Pick<Socket, 'emit'>;
  toolId: string;
  eventName: 'tool_result' | 'action_call_result';
  sessionId: string;
}

export interface BrowserToolCall {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * Execute a tool/action and emit the result via WebSocket
 * This unified function handles both browser tools and AG-UI actions
 * @param config Configuration for tool execution and result emission
 * @param executor Function that executes the tool/action
 */
export async function executeToolAndEmitResult<T>(
  config: ToolExecutionConfig,
  executor: () => Promise<T>,
): Promise<void> {
  try {
    const result = await executor();

    // Emit success result
    config.socket.emit(config.eventName, {
      toolCallId: config.toolId,
      sessionId: config.sessionId,
      result,
    });
  } catch (error) {
    // Emit error result
    config.socket.emit(config.eventName, {
      toolCallId: config.toolId,
      sessionId: config.sessionId,
      result:
        config.eventName === 'action_call_result'
          ? {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
            }
          : null,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Run a browser tool and return its result to the exact Oracle session that
 * issued the call. Browser tools use the same session correlation contract as
 * AG-UI actions.
 */
export async function executeBrowserToolCall(
  socket: Pick<Socket, 'emit'>,
  browserTools: Record<string, Pick<IBrowserToolParams, 'fn'>> | undefined,
  data: BrowserToolCall,
): Promise<void> {
  await executeToolAndEmitResult(
    {
      socket,
      toolId: data.toolCallId,
      eventName: 'tool_result',
      sessionId: data.sessionId,
    },
    async () => {
      const tool = browserTools?.[data.toolName];
      if (!tool) {
        throw new Error(`Tool ${data.toolName} not found`);
      }
      return tool.fn(data.args);
    },
  );
}
