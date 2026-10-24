import { z } from 'zod';

export const IXO_MCP_SCOPE = 'ixo:tools:read';
const httpsUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.href === value || url.origin === value)
      );
    } catch {
      return false;
    }
  }, 'Expected a canonical HTTPS URL without credentials, query or fragment');
const origin = httpsUrl
  .refine((value) => new URL(value).origin === value.replace(/\/$/, ''))
  .transform((value) => new URL(value).origin);
const clientSchema = z.strictObject({
  clientId: z.string().min(1).max(256),
  disclosure: z.enum(['shared', 'private']).default('shared'),
  timezone: z
    .string()
    .min(1)
    .max(100)
    .default('UTC')
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }),
  origins: z.array(origin).max(32).default([]),
});
const configSchema = z
  .strictObject({
    resource: httpsUrl.refine((value) => new URL(value).pathname === '/v1/mcp'),
    issuer: httpsUrl.refine((value) => new URL(value).origin === value),
    resourceClientId: z.string().min(1).max(256),
    clients: z.array(clientSchema).min(1).max(100),
  })
  .refine(
    ({ clients }) =>
      new Set(clients.map((client) => client.clientId)).size === clients.length,
    'Client IDs must be unique',
  );
export type IxoMcpConfigInput = z.input<typeof configSchema>;
export type IxoMcpConfig = Readonly<
  Omit<z.output<typeof configSchema>, 'clients'> & {
    clients: readonly IxoMcpClient[];
  }
>;
export type IxoMcpClient = Readonly<
  Omit<z.output<typeof clientSchema>, 'origins'> & {
    origins: readonly string[];
  }
>;
export function parseIxoMcpConfig(input: unknown): IxoMcpConfig {
  const parsed = configSchema.parse(input);
  return Object.freeze({
    ...parsed,
    clients: Object.freeze(
      parsed.clients.map((client) =>
        Object.freeze({ ...client, origins: Object.freeze(client.origins) }),
      ),
    ),
  });
}
export function ixoMcpMetadataUrl(config: IxoMcpConfig): string {
  const resource = new URL(config.resource);
  return `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname === '/' ? '' : resource.pathname}`;
}
export function ixoMcpMetadata(config: IxoMcpConfig) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [IXO_MCP_SCOPE],
    bearer_methods_supported: ['header'],
  };
}
export function isIxoMcpResource(
  request: Request,
  config: IxoMcpConfig,
): boolean {
  return request.url === new URL(config.resource).href;
}
