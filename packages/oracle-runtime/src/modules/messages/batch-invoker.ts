import {
  transformGraphStateMessageToListMessageResponse,
  type ListOracleMessagesResponse,
} from '@ixo/common';
import { BadRequestException, Injectable } from '@nestjs/common';
import { type BaseMessage } from 'langchain';
import { TMainAgentGraphState } from 'src/graph/state.js';
import { AgentBuilder } from './agent-builder.js';
import { type SendMessagePayload } from './dto/send-message.dto.js';
import { type PreparedRequest } from './request-preparer.js';

export interface BatchInvokeInput {
  payload: SendMessagePayload & {
    msgFromMatrixRoom?: boolean;
    clientType?: 'matrix' | 'slack' | 'portal';
  };
  prepared: PreparedRequest;
  inputMessages: BaseMessage[];
}

export interface BatchInvokeResult {
  message: {
    type: string;
    content: string;
    id: string;
  };
  sessionId: string;
  messages?: ListOracleMessagesResponse['messages'];
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

    const { agent, stateInput, langGraphConfig } =
      await this.agentBuilder.build({ payload, prepared, inputMessages });

    // The shared config from AgentBuilder is tuned for `streamEvents`
    // (`version: 'v2'`, `streamMode: ['updates','messages']`). Passing a
    // non-'values' streamMode to `.invoke()` makes LangGraph return the
    // accumulated stream chunks (Array<[mode, data]>) instead of the final
    // state — strip those keys here so invoke returns TMainAgentGraphState.
    const { streamMode: _sm, version: _v, ...invokeConfig } = langGraphConfig;

    const result: TMainAgentGraphState = await agent.invoke(
      stateInput,
      invokeConfig,
    );
    const messages = result.messages;
    const lastMessage = messages?.at(-1);
    if (!lastMessage) {
      throw new BadRequestException('No message returned from the oracle');
    }
    return {
      message: {
        type: lastMessage.type,
        // `.text` flattens array-shaped content (Responses-API streams) to
        // the text blocks; `String()` would render those as [object Object].
        content: lastMessage.text,
        id: lastMessage.id ?? '',
      },
      sessionId: prepared.sessionId,
      ...(payload.returnAllMessages && {
        messages:
          transformGraphStateMessageToListMessageResponse(messages).messages,
      }),
    };
  }
}
