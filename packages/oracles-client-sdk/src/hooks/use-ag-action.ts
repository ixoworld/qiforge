import { useEffect } from 'react';
import { type z } from 'zod';
import { useOraclesContext } from '../providers/oracles-provider/oracles-context.js';

export interface AgActionConfig<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  parameters: TSchema;
  handler: (args: z.infer<TSchema>) => Promise<unknown> | unknown;
  render?: (props: {
    status?: 'isRunning' | 'done';
    args?: z.infer<TSchema>;
    result?: unknown;
    isLoading?: boolean;
  }) => React.ReactElement | null;
}

export interface AgAction {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  hasRender: boolean;
}

/**
 * Hook for registering AG-UI actions that the oracle can invoke
 * Similar to useCopilotAction from CopilotKit but for the IXO oracles framework
 *
 * @example
 * ```tsx
 * useAgAction({
 *   name: 'create_data_table',
 *   description: 'Create a data table with structured data',
 *   parameters: z.object({
 *     title: z.string().optional().describe('Table title'),
 *     columns: z.array(z.any()).describe('Column definitions'),
 *     data: z.array(z.any()).describe('Row data'),
 *   }),
 *   handler: async ({ columns, data, title }) => {
 *     // TypeScript knows the exact shape of the args!
 *     return { success: true, rowCount: data.length };
 *   },
 *   render: ({ status, args }) => {
 *     if (status === 'done' && args?.data) {
 *       return <DataTable {...args} />;
 *     }
 *     return null;
 *   }
 * });
 * ```
 */
export function useAgAction<TSchema extends z.ZodTypeAny>(
  config: AgActionConfig<TSchema>,
): void {
  const { registerAgAction, unregisterAgAction } = useOraclesContext();

  // Register action on mount and when action name changes
  useEffect(() => {
    const action: AgAction = {
      name: config.name,
      description: config.description,
      parameters: config.parameters,
      hasRender: !!config.render,
    };

    registerAgAction(
      action,
      config.handler,
      config.render as
        | ((props: Record<string, unknown>) => React.ReactElement | null)
        | undefined,
    );

    // Cleanup: unregister on unmount or when name changes
    return () => {
      unregisterAgAction(config.name);
    };
  }, [config.name]);
}
