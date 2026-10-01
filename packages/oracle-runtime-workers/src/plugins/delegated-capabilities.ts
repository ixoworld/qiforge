/**
 * Capabilities bundled plugins prove through the user's delegation to this
 * oracle. Each is both the plugin's `manifest.requires` and the capability
 * its invocations claim, so what the gate checks and what the downstream
 * service is shown cannot drift apart. A plugin that authorizes some other
 * way (VFS fetches its own `ixo:filesystem` delegation from the UCAN store)
 * or degrades without a grant (skills fall back to public capsules) declares
 * nothing.
 */
export interface DelegatedCapability {
  readonly resource: string;
  readonly action: string;
}

/** Memory Engine MCP: the memory plugin's tools. */
export const MEMORY_CAPABILITY: DelegatedCapability = {
  resource: 'ixo:memory',
  action: 'memory/*',
};

/** Sandbox MCP, and Composio, which routes through the sandbox. */
export const SANDBOX_CAPABILITY: DelegatedCapability = {
  resource: 'ixo:sandbox',
  action: 'sandbox/*',
};
