/** Canonical wire names of the runtime's session-scoped events. */
export const EVENT_NAMES = {
  toolCall: 'tool_call',
  actionCall: 'action_call',
  renderComponent: 'render_component',
  reasoning: 'reasoning',
  browserToolCall: 'browser_tool_call',
  router: 'router.update',
  messageCacheInvalidation: 'message_cache_invalidation',
} as const;
