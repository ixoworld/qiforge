import { catalog } from '@ixo/agent-tools';
import { z } from 'zod';

const origin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.origin === value &&
      !url.username &&
      !url.password
    );
  }, 'Expected an HTTPS origin without a path, credentials, query or fragment');
const toolName = z.enum(catalog.map((tool) => tool.name));
export const ixoToolsConfigSchema = z.object({
  IXO_TOOLS_SUBSCRIPTIONS_ORIGIN: origin,
  IXO_TOOLS_MEMORY_ORIGIN: origin,
  IXO_TOOLS_VFS_ORIGIN: origin,
  IXO_TOOLS_YELLOWCARD_ORIGIN: origin,
  IXO_TOOLS_UCAN_STORE_ORIGIN: origin,
  IXO_TOOLS_MODULES: z
    .string()
    .default(catalog.map((tool) => tool.name).join(','))
    .refine(
      (value) =>
        value === '' ||
        value
          .split(',')
          .every((name) => toolName.safeParse(name.trim()).success),
      'Unknown IXO tool module',
    ),
  IXO_TOOLS_ORACLE_KNOWLEDGE: z.enum(['public', 'private']).default('public'),
});

export function readIxoToolsConfig(record: Record<string, unknown>) {
  const config = ixoToolsConfigSchema.parse(record);
  return Object.freeze({
    origins: Object.freeze({
      subscriptions: config.IXO_TOOLS_SUBSCRIPTIONS_ORIGIN,
      memory: config.IXO_TOOLS_MEMORY_ORIGIN,
      vfs: config.IXO_TOOLS_VFS_ORIGIN,
      yellowcard: config.IXO_TOOLS_YELLOWCARD_ORIGIN,
    }),
    storeUrl: config.IXO_TOOLS_UCAN_STORE_ORIGIN,
    enabledTools: Object.freeze(
      config.IXO_TOOLS_MODULES === ''
        ? []
        : config.IXO_TOOLS_MODULES.split(',').map((name) =>
            toolName.parse(name.trim()),
          ),
    ),
    oracleKnowledge: config.IXO_TOOLS_ORACLE_KNOWLEDGE,
  });
}
export type IxoToolsConfig = ReturnType<typeof readIxoToolsConfig>;
