declare module '@ixo/oracle-runtime' {
  import { z } from 'zod';

  export { z };

  export interface PluginManifest {
    title: string;
    summary: string;
    whenToUse: string[];
    whenNotToUse?: string[];
    examples?: Array<{
      user: string;
      thought?: string;
      tool: string;
      args?: Record<string, unknown>;
    }>;
    tags?: string[];
    category?:
      | 'data'
      | 'communication'
      | 'automation'
      | 'memory'
      | 'integration'
      | 'ui'
      | 'auth'
      | 'observability'
      | 'core';
    visibility?: 'always' | 'on-demand' | 'silent';
    stability?: 'stable' | 'beta' | 'experimental';
  }

  export interface PluginContext {
    [key: string]: unknown;
  }

  export interface RuntimeContext {
    [key: string]: unknown;
  }

  export interface PluginTool {
    name: string;
    description: string;
    schema: z.ZodType;
    handler: (args: unknown, ctx: RuntimeContext) => Promise<unknown>;
    visibility?: 'always' | 'on-demand' | 'silent';
  }

  export abstract class OraclePlugin {
    abstract readonly name: string;
    abstract readonly version: string;
    abstract readonly manifest: PluginManifest;
    getTools?(ctx: PluginContext): PluginTool[] | Promise<PluginTool[]>;
  }

  export function tool(
    handler: (args: unknown, ctx: RuntimeContext) => Promise<unknown>,
    options: {
      name: string;
      description: string;
      schema: z.ZodType;
      visibility?: PluginTool['visibility'];
    },
  ): PluginTool;
}
