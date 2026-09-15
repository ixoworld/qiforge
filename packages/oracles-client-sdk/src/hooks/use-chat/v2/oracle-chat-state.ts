import {
  type ChatRunState,
  type ChatStatus,
  type IChatState,
  type IMessage,
  type StreamingMode,
  IDLE_RUN_STATE,
} from './types.js';

export const DEFAULT_STREAMING_THROTTLE_MS = 50;

export class OracleChatState implements IChatState {
  #messages: IMessage[];
  #status: ChatStatus = 'ready';
  #error: Error | undefined = undefined;
  #run: ChatRunState = IDLE_RUN_STATE;
  #callbacks = new Set<() => void>();
  #rafId: number | null = null;
  #streamingMode: StreamingMode;
  #throttleMs: number;
  #throttleTimer: ReturnType<typeof setTimeout> | null = null;
  #throttlePending = false;
  #onVisible: (() => void) | null = null;

  constructor(
    initialMessages: IMessage[] = [],
    streamingMode: StreamingMode = 'immediate',
    throttleMs: number = DEFAULT_STREAMING_THROTTLE_MS,
  ) {
    this.#messages = initialMessages;
    this.#streamingMode = streamingMode;
    this.#throttleMs = Math.max(0, throttleMs);
    // Browsers slow timers right down in a background tab, so a trailing
    // render held by the throttle could wait until the tab is shown again —
    // flush it the moment that happens.
    if (streamingMode === 'throttled' && typeof document !== 'undefined') {
      this.#onVisible = () => {
        if (document.visibilityState === 'visible') this.#flushThrottle();
      };
      document.addEventListener('visibilitychange', this.#onVisible);
    }
  }

  /** Deliver anything the throttle is holding, now. */
  #flushThrottle = (): void => {
    if (this.#throttleTimer !== null) {
      clearTimeout(this.#throttleTimer);
      this.#throttleTimer = null;
    }
    if (this.#throttlePending) {
      this.#throttlePending = false;
      this.#notify();
    }
  };

  get status(): ChatStatus {
    return this.#status;
  }

  set status(newStatus: ChatStatus) {
    this.#status = newStatus;
    this.#callCallbacks('state');
  }

  get error(): Error | undefined {
    return this.#error;
  }

  set error(newError: Error | undefined) {
    this.#error = newError;
    this.#callCallbacks('state');
  }

  get run(): ChatRunState {
    return this.#run;
  }

  set run(next: ChatRunState) {
    this.#run = next;
    this.#callCallbacks('state');
  }

  get messages(): IMessage[] {
    return this.#messages;
  }

  // The history is paged by the hook (older turns load on demand), so the
  // store holds exactly what was loaded — no cap on its own.
  set messages(newMessages: IMessage[]) {
    this.#messages = [...newMessages];
    this.#callCallbacks();
  }

  pushMessage = (message: IMessage): void => {
    this.#messages = [...this.#messages, message];
    this.#callCallbacks();
  };

  replaceMessage = (index: number, message: IMessage): void => {
    this.#messages = [
      ...this.#messages.slice(0, index),
      this.snapshot(message),
      ...this.#messages.slice(index + 1),
    ];
    this.#callCallbacks();
  };

  // Optimized for streaming - updates last message (90% of cases)
  updateLastMessage = (updater: (msg: IMessage) => IMessage): void => {
    if (this.#messages.length === 0) {
      return;
    }

    const lastIndex = this.#messages.length - 1;
    const message = this.#messages[lastIndex];
    if (!message) return;
    const updatedMessage = updater(message);

    this.#messages = [
      ...this.#messages.slice(0, lastIndex),
      this.snapshot(updatedMessage),
    ];
    this.#callCallbacks();
  };

  // For WebSocket tool calls - finds by ID when needed (10% of cases)
  updateMessageById = (
    id: string,
    updater: (msg: IMessage) => IMessage,
  ): void => {
    const index = this.#messages.findIndex((m) => m.id === id);
    if (index === -1) return;

    const message = this.#messages[index];
    if (!message) return;

    const updatedMessage = updater(message);
    this.replaceMessage(index, updatedMessage);
  };

  snapshot = <T extends IMessage>(value: T): T => {
    // Simple shallow copy - creates new references for React re-renders
    // No deep cloning needed since content is plain serializable data
    return { ...value };
  };

  subscribe = (callback: () => void): (() => void) => {
    this.#callbacks.add(callback);
    return () => {
      this.#callbacks.delete(callback);
    };
  };

  #notify = (): void => {
    this.#callbacks.forEach((callback) => callback());
  };

  /**
   * Hand a change to the subscribers. Message changes follow the streaming
   * mode; a `state` change (status, error, run) is always delivered at once,
   * flushing anything the throttle was holding.
   */
  #callCallbacks = (kind: 'message' | 'state' = 'message'): void => {
    if (this.#streamingMode === 'throttled') {
      if (kind === 'state') {
        if (this.#throttleTimer !== null) {
          clearTimeout(this.#throttleTimer);
          this.#throttleTimer = null;
        }
        this.#throttlePending = false;
        this.#notify();
        return;
      }
      // A hidden tab has no frame to save and its timers are throttled:
      // deliver at once so nothing waits for the tab to come back.
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      ) {
        this.#flushThrottle();
        this.#notify();
        return;
      }
      // Leading edge renders the first chunk at once; later chunks inside
      // the window are folded into one trailing render.
      if (this.#throttleTimer !== null) {
        this.#throttlePending = true;
        return;
      }
      this.#notify();
      this.#throttleTimer = setTimeout(() => {
        this.#throttleTimer = null;
        if (this.#throttlePending) {
          this.#throttlePending = false;
          this.#notify();
        }
      }, this.#throttleMs);
      return;
    }

    if (this.#streamingMode === 'immediate') {
      // Immediate mode: call callbacks synchronously
      this.#notify();
      return;
    }

    // Batched mode: existing RAF logic
    // Batch multiple rapid updates into single render frame
    // This is crucial for streaming performance
    if (this.#rafId !== null) {
      return; // Already scheduled
    }

    this.#rafId = requestAnimationFrame(() => {
      this.#rafId = null;
      this.#callbacks.forEach((callback) => {
        callback();
      });
    });
  };

  // Cleanup method to prevent memory leaks
  cleanup = (): void => {
    // Cancel any pending RAF
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
    if (this.#throttleTimer !== null) {
      clearTimeout(this.#throttleTimer);
      this.#throttleTimer = null;
    }
    this.#throttlePending = false;
    if (this.#onVisible) {
      document.removeEventListener('visibilitychange', this.#onVisible);
      this.#onVisible = null;
    }
    this.#callbacks.clear(); // Critical: Clear all callbacks to prevent leaks
    this.#messages = [];
    this.#error = undefined;
    this.#status = 'ready';
    this.#run = IDLE_RUN_STATE;
  };
}
