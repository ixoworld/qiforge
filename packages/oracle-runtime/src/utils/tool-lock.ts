const activeLocks = new Set<string>();

/**
 * Acquire an exclusive lock for the given key. Throws immediately if the key
 * is already locked (another invocation is in flight). Returns a release
 * function — always call it in a `finally` block.
 *
 * Scoped to the current process; sufficient for preventing the agent from
 * invoking a stateful tool in parallel within the same LangGraph turn
 * (all tool calls for one turn execute in the same process).
 *
 * Convention: key the lock as `${ctx.session.id}:<tool_name>` so locks are
 * isolated per session and per tool.
 *
 * @example
 * const release = acquireToolLock(`${ctx.session.id}:my_tool`);
 * try {
 *   // ... tool body
 * } finally {
 *   release();
 * }
 */
export function acquireToolLock(key: string): () => void {
  if (activeLocks.has(key)) {
    throw new Error(
      `A call to this tool is already in progress for this session. Wait for it to complete before calling again.`,
    );
  }
  activeLocks.add(key);
  return () => activeLocks.delete(key);
}
