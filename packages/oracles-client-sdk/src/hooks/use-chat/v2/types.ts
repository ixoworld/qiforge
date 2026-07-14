import {
  type BrowserToolCallEventPayload,
  type RenderComponentEventPayload,
  type ToolCallEventPayload,
} from '@ixo/oracles-events/types';
import { type IBrowserTools } from '../../../types/browser-tool.type.js';
import {
  type SSEActionCallEventData,
  type SSEErrorEventData,
  type SSEReasoningEventData,
  type SSEToolCallEventData,
} from '../../../utils/sse-parser.js';
import { type Event } from '../resolve-content.js';
import { type UIComponents } from '../resolve-ui-component.js';
import { type OracleChat } from './oracle-chat.js';
import type { SSEErrorEvent } from '../../../utils/sse-parser.js';

// Component metadata for deferred rendering
export interface IComponentMetadata {
  name: string;
  props: {
    id: string;
    args: unknown;
    status?: 'isRunning' | 'done' | 'error';
    output?: string;
    event?: Event;
    payload?:
      | ToolCallEventPayload
      | RenderComponentEventPayload
      | BrowserToolCallEventPayload
      | SSEErrorEvent
      | SSEActionCallEventData;
    isToolCall?: boolean;
    isAgAction?: boolean;
    toolName?: string; // Original tool name (for generic ToolCall component)
    error?: string;
  };
}

// Message content can be string, array of strings/metadata, or single metadata
export type MessageContent =
  | string
  | IComponentMetadata
  | Array<string | IComponentMetadata>;

export type MessageFeedback = 'approved' | 'disapproved';

export interface MessageFeedbackResponse {
  sessionId: string;
  messageId: string;
  feedback: MessageFeedback | null;
  updatedAt: string;
}

export interface ChatCapabilities {
  messageFeedback?: boolean;
}

export interface IMessage {
  id: string;
  content: MessageContent;
  type: 'ai' | 'human';
  chunks?: number;
  toolCalls?: {
    name: string;
    id: string;
    args: unknown;
    status?: 'isRunning' | 'done' | 'error';
    output?: string;
    error?: string;
  }[];
  reasoning?: string;
  isComplete?: boolean;
  isReasoning?: boolean;
  attachment?: Attachment;
  feedback?: MessageFeedback;
}

export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error';

export interface IChatState {
  status: ChatStatus;
  error: Error | undefined;
  messages: IMessage[];
  pushMessage: (message: IMessage) => void;
  replaceMessage: (index: number, message: IMessage) => void;
  updateLastMessage: (updater: (msg: IMessage) => IMessage) => void;
  updateMessageById: (id: string, updater: (msg: IMessage) => IMessage) => void;
  snapshot: <T extends IMessage>(thing: T) => T;
  subscribe: (callback: () => void) => () => void;
}

export interface IChatOptions {
  oracleDid: string;
  sessionId: string;
  onPaymentRequiredError: (claimIds: string[]) => void;
  browserTools?: IBrowserTools;
  uiComponents?: UIComponents;
  overrides?: {
    baseUrl?: string;
    wsUrl?: string;
  };
  streamingMode?: 'batched' | 'immediate';
}

export interface Attachment {
  mxcUri?: string;
  eventId?: string;
  filename: string;
  mimetype: string;
  size?: number;
  category?: string;
}

export interface ISendMessageOptions {
  oracleDid: string;
  sessionId: string;
  overrides?: {
    baseUrl?: string;
  };
  onPaymentRequiredError: (claimIds: string[]) => void;
  browserTools?: IBrowserTools;
  chatRef?: React.MutableRefObject<OracleChat>;
  refetchQueries?: () => Promise<void>;

  // NEW callbacks for streaming events
  onToolCall?: (data: {
    toolCallData: SSEToolCallEventData;
    requestId: string;
  }) => Promise<void>;
  onActionCall?: (data: {
    actionCallData: SSEActionCallEventData;
    requestId: string;
  }) => Promise<void>;
  onError?: (data: {
    error: SSEErrorEventData;
    requestId: string;
  }) => Promise<void>;
  onReasoning?: (data: {
    reasoningData: SSEReasoningEventData;
    requestId: string;
  }) => Promise<void>;
}

interface IUIComponentProps {
  id: string;
  isLoading?: boolean;
  output?: string;
  status?: 'isRunning' | 'done' | 'error';
}

// Extract the payload type more carefully to avoid Record<string, any> fallback
export type UIComponentProps<Ev extends AnyEvent> = IUIComponentProps &
  (Ev extends { payload: infer P } ? P : never);

// EVENT TYPES - simplified without useLiveEvents

export type ToolCallEvent = {
  eventName: 'tool_call';
  payload: ToolCallEventPayload;
};

export type RenderComponentEvent = {
  eventName: 'render_component';
  payload: RenderComponentEventPayload;
};

export type BrowserToolCallEvent = {
  eventName: 'browser_tool_call';
  payload: BrowserToolCallEventPayload;
};

export type AnyEvent =
  | ToolCallEvent
  | RenderComponentEvent
  | BrowserToolCallEvent;

export type { MessagesMap } from '../transform-to-messages-map.js';
