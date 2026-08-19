import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  type Checkpoint,
  emptyCheckpoint,
  uuid6,
} from '@langchain/langgraph-checkpoint';

export function checkpointWithMessages(
  clock: number,
  messages: Array<HumanMessage | AIMessage>,
): Checkpoint {
  return {
    ...emptyCheckpoint(),
    id: uuid6(clock),
    channel_values: { messages },
  };
}

export function message(
  kind: 'human' | 'ai',
  id: string,
  content: string,
  timestamp: string,
): HumanMessage | AIMessage {
  const fields = {
    id,
    content,
    additional_kwargs: { timestamp },
  };
  return kind === 'human' ? new HumanMessage(fields) : new AIMessage(fields);
}
