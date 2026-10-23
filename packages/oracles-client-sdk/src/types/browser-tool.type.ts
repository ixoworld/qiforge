import { type z } from 'zod';
import { type ZodTypeAny as ZodV3Type } from 'zod/v3';

/** A tool's parameter schema: a zod 4 schema, or a `zod/v3` one. */
export type ToolSchema = z.ZodType | ZodV3Type;

export interface IBrowserToolParams {
  description: string;
  schema: ToolSchema;
  toolName: string;
  fn: <T>(args: T) => Promise<unknown>;
  /**
   * What the tool does: `read` only looks (it may run again after the oracle
   * restarts mid-call), `write` changes something (never repeated blindly).
   * Omitted → the oracle classifies it by its name, and an unrecognised name
   * counts as a write. The oracle treats its human-decision tools
   * (`ask_user_question`, …) as writes whatever is declared.
   */
  effect?: 'read' | 'write';
}

export type IBrowserTools = Record<string, IBrowserToolParams>;
