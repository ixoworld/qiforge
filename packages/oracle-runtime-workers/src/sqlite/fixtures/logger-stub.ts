/* eslint-disable no-console -- this stub IS the console logger */
/**
 * Stand-in for `@ixo/logger` when the fixture generator loads the Node
 * runtime's `@ixo/sqlite-saver` source under tsx (the workspace package is
 * not built in a fresh checkout). Mapped via `fixtures/tsconfig.json` paths.
 */
export const Logger = {
  info: (...args: unknown[]): void => console.info(...args),
  warn: (...args: unknown[]): void => console.warn(...args),
  error: (...args: unknown[]): void => console.error(...args),
  debug: (...args: unknown[]): void => console.debug(...args),
};
