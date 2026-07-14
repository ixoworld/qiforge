import { JobExecutor } from './job-executor.js';
import { OracleChatState } from './oracle-chat-state.js';
import { type ChatStatus, type IChatOptions, type IMessage } from './types.js';

export class OracleChat {
  readonly id: string;
  #state: OracleChatState;
  #jobExecutor = new JobExecutor();

  constructor(options: IChatOptions) {
    this.id = options.sessionId;
    this.#state = new OracleChatState([], options.streamingMode ?? 'immediate');
  }

  get status() {
    return this.#state.status;
  }

  get error() {
    return this.#state.error;
  }

  get messages(): IMessage[] {
    return this.#state.messages;
  }

  get lastMessage(): IMessage | undefined {
    const messages = this.#state.messages;
    return messages[messages.length - 1];
  }

  set messages(messages: IMessage[]) {
    this.#state.messages = messages;
  }

  setStatus(status: ChatStatus, error?: Error) {
    this.#state.status = status;
    if (error) {
      this.#state.error = error;
    }
  }

  // Optimized for streaming AI responses (super fast)
  appendToLastMessage = async (chunk: string): Promise<void> => {
    return this.#jobExecutor.run(async () => {
      this.#state.updateLastMessage((msg) => ({
        ...msg,
        content:
          typeof msg.content === 'string' ? msg.content + chunk : msg.content,
      }));
    });
  };

  // Create or update AI message for streaming
  upsertAIMessage = async (requestId: string, chunk: string): Promise<void> => {
    return this.#jobExecutor.run(async () => {
      const lastMessage = this.lastMessage;

      // If last message is the one we're updating, append to it
      if (lastMessage?.id === requestId && lastMessage.type === 'ai') {
        this.#state.updateLastMessage((msg) => ({
          ...msg,
          content:
            typeof msg.content === 'string' ? msg.content + chunk : chunk,
        }));
      } else {
        // Check if message exists elsewhere in the array
        const existingIndex = this.#state.messages.findIndex(
          (m) => m.id === requestId,
        );

        if (existingIndex >= 0) {
          const message = this.#state.messages[existingIndex];
          if (!message) {
            throw new Error('Message not found');
          }
          // Update existing message
          this.#state.replaceMessage(existingIndex, {
            ...message,
            content:
              typeof message.content === 'string'
                ? message.content + chunk
                : chunk,
          });
        } else {
          // Create new AI message
          this.#state.pushMessage({
            id: requestId,
            type: 'ai',
            content: chunk,
          });
        }
      }
    });
  };

  // Add user message
  addUserMessage = async (message: IMessage): Promise<void> => {
    return this.#jobExecutor.run(async () => {
      this.#state.pushMessage(message);
    });
  };

  updateMessageById = async (
    messageId: string,
    updater: (message: IMessage) => IMessage,
  ): Promise<void> => {
    return this.#jobExecutor.run(async () => {
      this.#state.updateMessageById(messageId, updater);
    });
  };

  // For WebSocket tool calls (finds by ID when needed)
  updateToolCall = async (
    messageId: string,
    toolCallUpdate: {
      id: string;
      status?: 'isRunning' | 'done';
      output?: string;
      args?: unknown;
      name?: string;
    },
  ): Promise<void> => {
    return this.#jobExecutor.run(async () => {
      this.#state.updateMessageById(messageId, (msg) => ({
        ...msg,
        toolCalls:
          msg.toolCalls?.map((tc) =>
            tc.id === toolCallUpdate.id ? { ...tc, ...toolCallUpdate } : tc,
          ) || [],
      }));
    });
  };

  // For WebSocket events - add event-based message
  upsertEventMessage = async (message: IMessage): Promise<void> => {
    return this.#jobExecutor.run(async () => {
      const existingIndex = this.#state.messages.findIndex(
        (m) => m.id === message.id,
      );
      if (existingIndex >= 0) {
        const existingMessage = this.#state.messages[existingIndex];
        if (!existingMessage) {
          throw new Error('Message not found');
        }

        // Special handling for reasoning messages - accumulate content
        if (message.type === 'ai' && existingMessage.type === 'ai') {
          this.#state.replaceMessage(existingIndex, {
            ...message,
            content:
              typeof existingMessage.content === 'string' &&
              typeof message.content === 'string'
                ? existingMessage.content + message.content
                : message.content,
            reasoning:
              (existingMessage.reasoning || '') + (message.reasoning || ''), // Safe concatenation
            isReasoning: message.isReasoning || existingMessage.isReasoning, // Keep reasoning flag if either has it
          });
        } else {
          // Default behavior - replace entire message
          this.#state.replaceMessage(existingIndex, message);
        }
      } else {
        this.#state.pushMessage(message);
      }
    });
  };

  // Clear error state
  clearError = (): void => {
    if (this.#state.status === 'error') {
      this.#state.error = undefined;
      this.#state.status = 'ready';
    }
  };

  // Set initial messages from React Query
  setInitialMessages = async (messages: IMessage[]): Promise<void> => {
    return this.#jobExecutor.run(async () => {
      this.#state.messages = messages;
    });
  };

  subscribe = (callback: () => void): (() => void) => {
    return this.#state.subscribe(callback);
  };

  // Cleanup method to prevent memory leaks
  cleanup = (): void => {
    // Use the state's cleanup method which clears callbacks too
    this.#state.cleanup();
  };
}
