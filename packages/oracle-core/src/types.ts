/**
 * Structural logger contract shared by every core module. Deliberately
 * minimal and platform-free — the Node adapter satisfies it with its Nest
 * logger, a Worker adapter with `console`-backed bindings.
 */
export interface Logger {
  log(message: unknown, ...optional: unknown[]): void;
  error(message: unknown, ...optional: unknown[]): void;
  warn(message: unknown, ...optional: unknown[]): void;
  debug?(message: unknown, ...optional: unknown[]): void;
  verbose?(message: unknown, ...optional: unknown[]): void;
  /**
   * Returns a new logger that auto-prefixes records with the given context.
   * Optional — when absent, the same logger is returned unchanged.
   */
  child?(bindings: Record<string, unknown>): Logger;
}
