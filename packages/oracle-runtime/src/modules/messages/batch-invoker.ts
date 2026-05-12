import { Injectable, BadRequestException } from '@nestjs/common';
import { type BaseMessage, type HumanMessage } from 'langchain';
import { AgentBuilder } from './agent-builder.js';
import { type SendMessagePayload } from './dto/send-message.dto.js';
import { type PreparedRequest } from './request-preparer.js';

export interface BatchInvokeInput {
  payload: SendMessagePayload & {
    msgFromMatrixRoom?: boolean;
    clientType?: 'matrix' | 'slack' | 'portal';
  };
  prepared: PreparedRequest;
  inputMessages: HumanMessage[];
}

export interface BatchInvokeResult {
  message: {
    type: string;
    content: string;
    id: string;
  };
  sessionId: string;
}

/**
 * Non-streaming chat path: builds the agent, invokes it once, returns the
 * last assistant message.
 *
 * Mirrors the streaming runner's agent-build contract so adding state
 * fields (browser tools, AG-UI actions, editor room, etc.) automatically
 * applies to both paths — same AgentBuilder, same per-request state shape.
 */
@Injectable()
export class BatchInvoker {
  constructor(private readonly agentBuilder: AgentBuilder) {}

  async invoke(input: BatchInvokeInput): Promise<BatchInvokeResult> {
    const { payload, prepared, inputMessages } = input;

    const { agent, stateInput, langGraphConfig } = await this.agentBuilder.build(
      { payload, prepared, inputMessages },
    );

    const result = await agent.invoke(stateInput, langGraphConfig);
    const messages = (result as { messages: BaseMessage[] }).messages;
    const lastMessage = messages?.at(-1);
    if (!lastMessage) {
      throw new BadRequestException('No message returned from the oracle');
    }
    return {
      message: {
        type: lastMessage.getType(),
        content: String(lastMessage.content),
        id: lastMessage.id ?? '',
      },
      sessionId: prepared.sessionId,
    };
  }
}
