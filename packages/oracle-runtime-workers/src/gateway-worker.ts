/* eslint-disable no-console -- console IS the logger on Workers (Logs/observability). */
/**
 * Entry for a deployment that runs the Matrix gateway as its OWN Worker
 * script (`@ixo/oracle-runtime-workers/gateway`).
 *
 * Every Durable Object of one script shares that script's isolate on a
 * server, and an isolate has a 128 MB heap. In the single-script layout the
 * gateway (matrix-js-sdk, the crypto wasm, the sync store — tens of MB that
 * never go away) sits in the same heap as every user object on that server,
 * so a user's flush or import spike can reset the gateway and vice versa.
 * With the gateway in a second script it gets its own isolate and its own
 * budget; the user script's isolate holds only user objects.
 *
 * The two scripts talk over cross-script Durable Object bindings
 * (`script_name` in the wrangler config): the shell's `MATRIX_GATEWAY`
 * binding points at this script's class, this script's `USER_ORACLE`
 * binding points back at the shell script's user class. RPC is identical
 * either way, so nothing in the objects changes — this entry only exports
 * the class and a keep-alive cron. This module deliberately imports nothing
 * from the agent side (`core/`, `plugins/`), so the gateway bundle carries no
 * LangChain, no MCP clients and no editor code.
 */
import type { OracleWorkerEnv } from './do/contracts';
import { MatrixGatewayDO } from './matrix/gateway-do';

export { MatrixGatewayDO } from './matrix/gateway-do';

export interface GatewayWorker {
  fetch: (
    request: Request,
    env: OracleWorkerEnv,
    ctx: ExecutionContext,
  ) => Promise<Response>;
  scheduled: (
    event: ScheduledController,
    env: OracleWorkerEnv,
    ctx: ExecutionContext,
  ) => Promise<void>;
  MatrixGatewayDO: typeof MatrixGatewayDO;
}

function gatewayStub(env: OracleWorkerEnv) {
  return env.MATRIX_GATEWAY.get(env.MATRIX_GATEWAY.idFromName(env.ORACLE_DID));
}

/**
 * Build the gateway script's handlers. The script needs no public route
 * (`workers_dev: false` is fine): the shell reaches the gateway through the
 * binding, and `/matrix/status`, `/debug/matrix/*` stay on the shell. The
 * fetch handler answers `/health` for a deployment that does get a route
 * and 404s everything else; the cron is the keep-alive safety net, same as
 * the single-script layout's.
 */
export function createGatewayWorker(): GatewayWorker {
  return {
    MatrixGatewayDO,
    fetch: async (request, env, ctx) => {
      const { pathname } = new URL(request.url);
      if (
        request.method === 'GET' &&
        (pathname === '/' || pathname === '/health')
      ) {
        ctx.waitUntil(
          gatewayStub(env)
            .ensureStarted()
            .catch((err) =>
              console.error('[matrix] ensureStarted failed', err),
            ),
        );
        return Response.json({
          ok: true,
          role: 'matrix-gateway',
          oracleDid: env.ORACLE_DID,
        });
      }
      return new Response('Not found', { status: 404 });
    },
    scheduled: async (_event, env) => {
      await gatewayStub(env).ensureStarted();
    },
  };
}
