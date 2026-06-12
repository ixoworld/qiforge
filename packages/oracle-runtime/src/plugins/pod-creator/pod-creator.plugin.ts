import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type { PluginManifest } from '../../plugin-api/types.js';

/**
 * Plugin-owned env vars. The capsules registry URL and `NETWORK` are read as
 * siblings from the merged config (owned by the skills plugin / base schema),
 * so they are intentionally NOT redeclared here — that would collide in the
 * config-schema registry when both plugins are loaded.
 */
const configSchema = z.object({
  /** Marketplace endpoint used by the commercial-packager listing draft. */
  POD_CREATOR_MARKETPLACE_URL: z.url().optional(),
  /**
   * Must be explicitly enabled before a mainnet creation batch can be
   * prepared. Testnet / devnet require no opt-in. Accepts a real boolean
   * (tests / programmatic config) or the string `'true'` / `'false'` (env).
   */
  POD_CREATOR_ALLOW_MAINNET: z
    .union([
      z.boolean(),
      z.enum(['true', 'false']).transform((value) => value === 'true'),
    ])
    .default(false),
});

const manifest: PluginManifest = {
  title: 'POD Creator',
  summary:
    'Design and create an IXO Programmable Organisational Domain (POD) end to end — qualify, architect, build, evaluate, then prepare an on-chain creation batch for the user to sign.',
  whenToUse: [
    'User wants to create, design, or stand up a new POD (Programmable Organisational Domain) or service domain on IXO.',
    'User describes a service or organisation they want to launch and asks the oracle to turn it into a working POD.',
  ],
  whenNotToUse: [
    'Operating or supporting an already-live POD — out of scope for now.',
    'Generic on-chain entity creation unrelated to POD design.',
  ],
  tags: ['pod', 'domain', 'design', 'orchestration', 'on-chain'],
  category: 'automation',
  visibility: 'on-demand',
  stability: 'experimental',
};

/**
 * POD-creator plugin.
 *
 * Runs the design-pod lifecycle: a conductor (the main agent) drives the
 * specialist sub-agents to design a POD, then prepares an unsigned on-chain
 * creation batch for the user's wallet to sign. Each specialist's instructions
 * are loaded from the ai-skills capsule registry per stage via the
 * `CapsuleContentClient`.
 *
 * This is the plugin shell — identity, manifest, config, soft dependencies.
 * The orchestration tools, specialist sub-agents, and create path are wired in
 * subsequent slices.
 */
export class PodCreatorPlugin extends OraclePlugin {
  readonly name = 'pod-creator';
  readonly version = '0.1.0';
  readonly manifest = manifest;
  override readonly softDependsOn = [
    'agui',
    'editor',
    'domain-indexer',
    'memory',
  ];
  override readonly configSchema = configSchema;
}
