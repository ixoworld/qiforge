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

/**
 * Anonymous feedback on one completed Agent reply. The context is a fixed
 * allowlist of coarse values; the runtime refuses anything else.
 */
export type AnonymousMessageFeedbackSurface = 'workspace' | 'agentSidebar';
export type AnonymousMessageFeedbackTheme = 'dark' | 'light';
export type AnonymousMessageFeedbackDeviceClass =
  | 'mobile'
  | 'tablet'
  | 'desktop';
export type AnonymousMessageFeedbackViewportBucket =
  | 'compact'
  | 'medium'
  | 'wide';
export type AnonymousMessageFeedbackNetwork =
  | 'mainnet'
  | 'testnet'
  | 'devnet'
  | 'unknown';

export interface AnonymousMessageFeedbackContext {
  surface: AnonymousMessageFeedbackSurface;
  /** Language with an optional region only: `en`, `en-GB`, `es-419`. */
  locale: string;
  theme: AnonymousMessageFeedbackTheme;
  deviceClass: AnonymousMessageFeedbackDeviceClass;
  viewportBucket: AnonymousMessageFeedbackViewportBucket;
  network: AnonymousMessageFeedbackNetwork;
  /** A release (`1.4.0`, `1.5.0-rc.2`, `1.4.0+4f2ea36`) or a commit sha, at most 40 characters. */
  portalBuildVersion?: string;
}

export interface AnonymousMessageFeedbackSubmission {
  /** A UUID v4 the client generates once per submission and reuses on retry. */
  submissionId: string;
  /** 1–2000 characters, free of personal identifiers and secrets. */
  feedback: string;
  context: AnonymousMessageFeedbackContext;
}

export interface AnonymousMessageFeedbackResponse {
  submissionId: string;
  status: 'submitted';
  submittedAt: string;
}

/**
 * The `code` on a refused feedback submission (`RequestError.code`).
 * `FEEDBACK_IN_FLIGHT`, `FEEDBACK_RATE_LIMITED` and `FEEDBACK_DELIVERY_FAILED`
 * are `retryable`: send the same submission again later.
 */
export type AnonymousMessageFeedbackErrorCode =
  | 'FEEDBACK_DISABLED'
  | 'FEEDBACK_INVALID'
  | 'FEEDBACK_EMPTY'
  | 'FEEDBACK_TARGET_NOT_FOUND'
  | 'FEEDBACK_IN_FLIGHT'
  | 'FEEDBACK_ALREADY_SUBMITTED'
  | 'FEEDBACK_CONTAINS_PERSONAL_DATA'
  | 'FEEDBACK_RATE_LIMITED'
  | 'FEEDBACK_DELIVERY_FAILED';

/** Optional features a runtime advertises with the transcript. */
export interface ChatCapabilities {
  anonymousMessageFeedback?: boolean;
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
  /** First attachment — kept for clients that only read the singular field. */
  attachment?: Attachment;
  attachments?: Attachment[];
}

export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error';

/**
 * The durable run behind the current (or last) turn — what a chat UI needs
 * beyond `status` once a runtime can lose the connection or restart
 * mid-reply and pick the turn up again.
 */
export interface ChatRunState {
  runId: string | null;
  requestId: string | null;
  /** The stream dropped and the client is re-joining the run. */
  reconnecting: boolean;
  /** Times the runtime restarted and resumed this turn. */
  resumed: number;
  /**
   * How the last run ended: `done` (the reply is complete), `aborted` (the
   * user stopped it), `interrupted` (the runtime gave up after repeated
   * restarts; the kept text is shown), `failed`, or `disconnected` (the
   * client could not re-join; the reply lands in the transcript when the
   * runtime finishes it), or `unauthorized` (the runtime refused the
   * re-join's credentials after both renewal stages — a fresh invocation,
   * then a fresh delegation and invocation — or for a reason new
   * credentials cannot fix; the chat's status is `error` and the reply
   * lands in the transcript as with `disconnected`). A message whose POST
   * is still refused after both stages was not sent: the send fails with
   * the refusal's `RequestError` (status 401/403) instead.
   */
  ended:
    | 'done'
    | 'aborted'
    | 'interrupted'
    | 'failed'
    | 'disconnected'
    | 'unauthorized'
    | null;
}

export const IDLE_RUN_STATE: ChatRunState = {
  runId: null,
  requestId: null,
  reconnecting: false,
  resumed: 0,
  ended: null,
};

export interface IChatState {
  status: ChatStatus;
  error: Error | undefined;
  run: ChatRunState;
  messages: IMessage[];
  pushMessage: (message: IMessage) => void;
  replaceMessage: (index: number, message: IMessage) => void;
  updateLastMessage: (updater: (msg: IMessage) => IMessage) => void;
  updateMessageById: (id: string, updater: (msg: IMessage) => IMessage) => void;
  snapshot: <T extends IMessage>(thing: T) => T;
  subscribe: (callback: () => void) => () => void;
}

export type StreamingMode = 'batched' | 'immediate' | 'throttled';

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
  /**
   * How store changes reach React while a reply streams. `immediate` (the
   * default) renders on every chunk; `batched` groups changes per animation
   * frame; `throttled` renders at once for the first change and then at most
   * once per `streamingThrottleMs`, whatever the model's chunk rate — the
   * right choice for a conversation view with any real render cost.
   */
  streamingMode?: StreamingMode;
  /** The `throttled` window in milliseconds (default 50). */
  streamingThrottleMs?: number;
  /**
   * Turns per history page (default 20). The hook loads the newest page
   * first and older pages on demand (`loadEarlier`); against a runtime
   * without paging the whole transcript comes in one page.
   */
  historyPageSize?: number;
  /**
   * Model id to answer with, chosen from `useModels()` / `GET /models`. When
   * omitted the oracle's default model is used. Model is a conversation-level
   * setting (like the ChatGPT/Claude switcher): the value in effect at send
   * time is applied to that message.
   */
  model?: string;
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
  /** Model id to answer with; omitted → the oracle's default model. */
  model?: string;

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
