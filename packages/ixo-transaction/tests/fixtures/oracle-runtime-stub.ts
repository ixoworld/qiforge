import { z } from 'zod';

export { z };

export class OraclePlugin {}

export function tool(
  handler: unknown,
  options: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...options,
    handler,
  };
}
