import { type z } from 'zod';
import { type ZodTypeAny as ZodV3Type } from 'zod/v3';

/** A tool's parameter schema: a zod 4 schema, or a `zod/v3` one. */
export type ToolSchema = z.ZodType | ZodV3Type;

export interface IBrowserToolParams {
  description: string;
  schema: ToolSchema;
  toolName: string;
  fn: <T>(args: T) => Promise<unknown>;
}

export type IBrowserTools = Record<string, IBrowserToolParams>;
