import { z } from 'zod';
import type {
  DecisionDefinition,
  DecisionRequest,
} from './types.js';
import { validateDecisionRequest } from './validation.js';

export interface DefineDecisionOptions<TSchema extends z.ZodType> {
  name: string;
  version: string;
  description: string;
  inputSchema: TSchema;
  timeoutMs?: number;
  project(input: z.infer<TSchema>): DecisionRequest;
}

export function defineDecision<TSchema extends z.ZodType>(
  options: DefineDecisionOptions<TSchema>,
): DecisionDefinition<z.infer<TSchema>> {
  if (!options.name.trim()) {
    throw new Error('Decision name must be non-empty.');
  }
  if (!options.version.trim()) {
    throw new Error('Decision version must be non-empty.');
  }
  if (!options.description.trim()) {
    throw new Error('Decision description must be non-empty.');
  }

  return {
    name: options.name,
    version: options.version,
    description: options.description,
    inputSchema: options.inputSchema,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    project: options.project,
    prepare(input: unknown) {
      const parsed = options.inputSchema.parse(input);
      const request = options.project(parsed);
      validateDecisionRequest(request);
      return request;
    },
  };
}
