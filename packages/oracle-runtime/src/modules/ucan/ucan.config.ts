/**
 * @fileoverview UCAN configuration for Oracle MCP endpoints
 *
 * This module defines the UCAN authorization requirements for MCP tools.
 * Each MCP server/tool can be configured to require UCAN authorization.
 */

/**
 * MCP capability actions
 */
type MCPAction = 'mcp/call' | 'mcp/*';

/**
 * Configuration for MCP tool UCAN requirements
 */
interface MCPUCANRequirement {
  /** The action required (e.g., 'mcp/call') */
  can: MCPAction;
  /** Pattern for the resource URI */
  withPattern: string;
  /** Whether this MCP server/tool requires UCAN authorization */
  requiresAuth: boolean;
}

/**
 * Map of MCP server names to their UCAN requirements
 */
export interface MCPUCANConfig {
  /** This oracle's DID (will be the audience for invocations) */
  oracleDid: string;
  /** Root DIDs allowed to self-issue capabilities */
  rootIssuers: string[];
  /** Per-MCP-server authorization requirements */
  requirements: Record<string, MCPUCANRequirement>;
}

/**
 * Default UCAN requirement for MCP tools
 * Requires the 'mcp/call' action on the specific tool resource
 */
const defaultMCPRequirement: Omit<MCPUCANRequirement, 'requiresAuth'> = {
  can: 'mcp/call',
  // Pattern: ixo:oracle:{oracleDid}:mcp/{serverName}/{toolName}
  withPattern: 'ixo:oracle:{oracleDid}:mcp/{serverName}/{toolName}',
};

/**
 * Create the UCAN configuration for this oracle
 *
 * @param oracleDid - The oracle's DID (audience for invocations)
 * @param rootIssuers - DIDs allowed to be root issuers
 * @param protectedServers - Map of MCP server names to whether they require UCAN
 * @returns The complete UCAN configuration
 *
 * @example
 * ```typescript
 * const config = createMCPUCANConfig(
 *   'did:ixo:oracle123',
 *   ['did:ixo:admin'],
 *   {
 *     postgres: true,    // Requires UCAN
 *     filesystem: false, // No UCAN required
 *   }
 * );
 * ```
 */
export function createMCPUCANConfig(
  oracleDid: string,
  rootIssuers: string[],
  protectedServers: Record<string, boolean> = {},
): MCPUCANConfig {
  const requirements: Record<string, MCPUCANRequirement> = {};

  for (const [serverName, requiresAuth] of Object.entries(protectedServers)) {
    requirements[serverName] = {
      ...defaultMCPRequirement,
      requiresAuth,
    };
  }

  return {
    oracleDid,
    rootIssuers,
    requirements,
  };
}

/**
 * Check if an MCP tool requires UCAN authorization
 *
 * @param config - The UCAN configuration
 * @param serverName - The MCP server name
 * @param toolName - The tool name (optional, for tool-level checks)
 * @returns Whether the tool requires UCAN authorization
 */
export function requiresUCANAuth(
  config: MCPUCANConfig,
  serverName: string,
  _toolName?: string,
): boolean {
  const requirement = config.requirements[serverName];
  if (!requirement) {
    // Default: no UCAN required for unconfigured servers
    return false;
  }

  return requirement.requiresAuth;
}

/**
 * Build the required capability for an MCP tool
 *
 * @param config - The UCAN configuration
 * @param serverName - The MCP server name
 * @param toolName - The tool name
 * @returns The required capability object
 */
export function buildRequiredCapability(
  config: MCPUCANConfig,
  serverName: string,
  toolName: string,
): { can: string; with: string } {
  const requirement = config.requirements[serverName] ?? defaultMCPRequirement;

  // Replace placeholders in the pattern
  const withUri = requirement.withPattern
    .replace('{oracleDid}', config.oracleDid)
    .replace('{serverName}', serverName)
    .replace('{toolName}', toolName);

  return {
    can: requirement.can,
    with: withUri,
  };
}

/**
 * Environment-based configuration loader
 *
 * Reads UCAN configuration from environment variables:
 * - ORACLE_ENTITY_DID: The oracle's DID
 * - UCAN_ROOT_ISSUERS: Comma-separated list of root issuer DIDs
 * - UCAN_PROTECTED_MCP_SERVERS: Comma-separated list of MCP server names that require UCAN
 *
 * @returns The UCAN configuration from environment
 */
export function loadUCANConfigFromEnv(): MCPUCANConfig {
  const oracleDid = process.env.ORACLE_ENTITY_DID ?? '';

  const rootIssuers = (process.env.UCAN_ROOT_ISSUERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const protectedServerNames = (process.env.UCAN_PROTECTED_MCP_SERVERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const protectedServers: Record<string, boolean> = {};
  for (const serverName of protectedServerNames) {
    protectedServers[serverName] = true;
  }

  return createMCPUCANConfig(oracleDid, rootIssuers, protectedServers);
}

// TODO: Add support for per-tool authorization requirements
// TODO: Add support for capability caveats (e.g., rate limiting)
// TODO: Add support for time-based restrictions
