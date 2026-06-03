import { type UIComponents } from './resolve-ui-component.js';
import { type IComponentMetadata, type IMessage } from './v2/types.js';

export type MessagesMap = Record<string, IMessage>;

export const DEFAULT_TOOL_CALL_COMPONENT_NAME = 'ToolCall';

export default function transformToMessagesMap({
  messages,
  uiComponents,
  agActionNames,
}: {
  messages: IMessage[];
  uiComponents?: UIComponents;
  agActionNames?: string[]; // List of AG action names to identify AG-UI tools
}): MessagesMap {
  const messagesMap: MessagesMap = {};

  messages.forEach((message) => {
    const isToolCall = message.toolCalls && message.toolCalls.length > 0;
    if (!isToolCall) {
      messagesMap[message.id] = message;
      return;
    }
    if (message.toolCalls && message.toolCalls.length === 0) {
      messagesMap[message.id] = message;
      return;
    }
    if (!uiComponents) {
      messagesMap[message.id] = message;
      return;
    }

    // Store metadata instead of React elements - build array of content
    const content: Array<string | IComponentMetadata> = [];

    // Add original content if it's a string
    if (typeof message.content === 'string') {
      content.push(message.content);
    }

    // Add component metadata for each tool call
    message.toolCalls?.forEach((toolCall) => {
      // Check if this tool name is in the list of AG actions
      const isAgAction = agActionNames?.includes(toolCall.name) ?? false;

      if (isAgAction) {
        // For AG-UI actions, create metadata with isAgAction flag
        const componentMetadata: IComponentMetadata = {
          name: toolCall.name,
          props: {
            id: toolCall.id,
            args: toolCall.args,
            status: toolCall.status,
            output: toolCall.output,
            isAgAction: true,
            toolName: toolCall.name,
          },
        };
        content.push(componentMetadata);
      } else {
        // For browser tools and regular tool calls
        const hasCustomComponent =
          uiComponents && toolCall.name in uiComponents;

        const componentMetadata: IComponentMetadata = {
          name: hasCustomComponent
            ? toolCall.name
            : DEFAULT_TOOL_CALL_COMPONENT_NAME,
          props: {
            id: toolCall.id,
            args: toolCall.args,
            status: toolCall.status,
            output: toolCall.output,
            isToolCall: true,
            toolName: toolCall.name,
          },
        };
        content.push(componentMetadata);
      }
    });

    messagesMap[message.id] = {
      ...message,
      content: content.filter(Boolean),
    };
  });
  return messagesMap;
}
