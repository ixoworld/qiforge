/**
 * Reference QiForge oracle on Cloudflare Workers.
 *
 * Everything an oracle needs is `createOracleWorker({ config, plugins })`:
 * the Hono shell (same HTTP/SSE protocol as the Node runtime), one Durable
 * Object per user holding their SQLite working copy + the agent turn, and one
 * Durable Object per oracle holding the Matrix bot (E2EE, sync loop).
 */
import {
  createOracleWorker,
  WeatherPlugin,
  SkillsPlugin,
  FlowsPlugin,
  BUNDLED_WORKERS_PLUGINS,
} from '@ixo/oracle-runtime-workers';
import { config } from './config';

const oracle = createOracleWorker({
  config,
  // The bundled Workers plugins (memory/sandbox/firecrawl/domain-indexer/
  // composio/vfs/tasks/editor) each self-gate on their env keys; those without
  // config quietly exclude themselves. Weather + Skills are the demo extras;
  // FlowsPlugin is opt-in by design, so the example constructs it explicitly.
  plugins: [
    new WeatherPlugin(),
    new SkillsPlugin(),
    new FlowsPlugin(),
    ...BUNDLED_WORKERS_PLUGINS,
  ],
  routes: [
    {
      method: 'GET',
      path: '/version',
      handler: () =>
        Response.json({
          name: 'QiForge Workers Example Oracle',
          description: 'Reference oracle on Cloudflare Workers',
        }),
    },
  ],
  authExcludedRoutes: [{ path: 'version', method: 'GET' }],
});

// Durable Object classes must be exported by name from the Worker entry —
// wrangler.jsonc binds `USER_ORACLE` / `MATRIX_GATEWAY` to them. In the
// split layout (wrangler.devnet.jsonc + wrangler.gateway.devnet.jsonc) the
// gateway class is served by `src/gateway.ts` instead and the export here is
// simply unbound.
export const { UserOracleDO, MatrixGatewayDO } = oracle;

export default {
  fetch: oracle.fetch,
  scheduled: oracle.scheduled,
};
