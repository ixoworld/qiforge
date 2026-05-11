import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type { PluginManifest } from '../../plugin-api/types.js';

/**
 * Claim processing — silent plugin that activates the background claim
 * worker for converting held credits into on-chain claims. Hard depends
 * on `credits`; the loader cascades it off whenever credits is off.
 *
 * The plugin itself contributes no agent-visible tools — the actual
 * workflow lives in `ClaimProcessingService` (a `@Cron`-driven Nest
 * service) shipped via `ClaimProcessingModule`. The runtime wires that
 * module in when this plugin is loaded.
 */
export class ClaimProcessingPlugin extends OraclePlugin {
  static readonly NAME = 'claim-processing';

  readonly name = ClaimProcessingPlugin.NAME;

  readonly version = '1.0.0';

  readonly manifest: PluginManifest = {
    title: 'Claim Processing',
    summary:
      'Submits held-credit claims to the chain on a fixed cadence — invisible to the agent.',
    whenToUse: [],
    visibility: 'silent',
    stability: 'stable',
    category: 'core',
  };

  override readonly dependsOn = ['credits'];
}
