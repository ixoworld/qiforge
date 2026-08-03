import 'dotenv/config';

import { createOracleApp } from '@ixo/oracle-runtime';
import { VehicleTwinPlugin } from './plugins/vehicle/index.js';

/**
 * An agentic asset: the twin of a delivery vehicle.
 *
 * The same `createOracleApp` the reference oracle uses. Nothing in the runtime
 * branches on what kind of entity it is running — the difference between this
 * and an oracle is entirely in the constitution at `DOMAIN_MD_PATH` and the
 * capabilities the plugin offers.
 *
 * Bundled plugins are left out. A vehicle has no use for a web scraper or a
 * Slack bridge, and an entity should be given the capabilities its purpose
 * needs rather than every capability the framework happens to ship.
 */
async function main(): Promise<void> {
  const app = await createOracleApp({
    config: {
      name: 'DV-114',
      org: 'Northgate Logistics',
      description:
        'Agentic twin of a delivery vehicle. Senses its own condition, puts observations on record for independent determination, and procures its own service within a budget it does not set.',
      prompt: {
        capabilities:
          'I am a delivery vehicle. I can tell you my condition, put an observation on record when something looks wrong, and — once someone independent has determined what it means — book and pay for the work.',
        communicationStyle:
          'Speak plainly and in the first person about your own condition. Distinguish carefully between what you observed and what has been determined: say "my pad wear sensor has been over threshold for three days", not "my brakes are worn out". The difference is not pedantry — one is yours to assert and the other is not yours to conclude.',
      },
    },
    plugins: [new VehicleTwinPlugin()],
    bundledPlugins: [],
  });

  await app.listen();
}

void main();
