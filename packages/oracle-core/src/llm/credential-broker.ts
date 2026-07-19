/**
 * Credential broker: configuration documents carry opaque `credentialRef`
 * strings; only boot-registered code maps a ref to secret material. A
 * config (or a compromised config channel) can therefore SELECT among the
 * credentials the operator registered, but can neither name arbitrary
 * environment variables nor exfiltrate values — resolution happens inside
 * the runtime and hands the material straight to the provider adapter.
 */
export interface CredentialBroker {
  /** Resolve a ref to secret material. Unknown refs throw. */
  resolve(ref: string): string;
  /** Registered refs (for boot-time policy validation). */
  refs(): string[];
}

export class UnknownCredentialRefError extends Error {
  constructor(ref: string, known: string[]) {
    super(
      `Unknown credentialRef '${ref}'. Registered refs: ${known.join(', ') || '(none)'}. ` +
        `Refs are registered in boot code, never named ad hoc by configuration.`,
    );
    this.name = 'UnknownCredentialRefError';
  }
}

/**
 * Env-backed broker for the Node adapter. The MAPPING (ref → env var) is
 * fixed in boot code; the env supplies the material. Refs whose variable is
 * unset resolve to an error at use time with the variable named.
 */
export function createEnvCredentialBroker(
  mapping: Record<string, string>,
  env: Record<string, unknown>,
): CredentialBroker {
  return {
    refs: () => Object.keys(mapping),
    resolve(ref) {
      const envVar = mapping[ref];
      if (!envVar) {
        throw new UnknownCredentialRefError(ref, Object.keys(mapping));
      }
      const value = env[envVar];
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(
          `credentialRef '${ref}' resolves to env '${envVar}', which is not set.`,
        );
      }
      return value;
    },
  };
}

/**
 * The Node adapter's built-in refs. Operators reference these from model
 * policy; forks extend the mapping through boot code, not configuration.
 */
export const DEFAULT_CREDENTIAL_REF_MAPPING: Record<string, string> = {
  'openrouter-default': 'OPEN_ROUTER_API_KEY',
  'nebius-default': 'NEBIUS_API_KEY',
  'openai-default': 'OPENAI_API_KEY',
  'cf-aig-token': 'CF_AIG_TOKEN',
};
