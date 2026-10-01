/**
 * The Matrix gateway as its own Worker script (see wrangler.gateway.*.jsonc).
 *
 * Deployed next to the oracle script from `src/index.ts`: that script keeps
 * the HTTP shell and the per-user objects, this one holds only the Matrix
 * bot object, so the two never share an isolate's memory. The oracle's
 * `MATRIX_GATEWAY` binding points here via `script_name`; the `USER_ORACLE`
 * binding here points back at the oracle script.
 */
import { createGatewayWorker } from '@ixo/oracle-runtime-workers/gateway';

const gateway = createGatewayWorker();

// wrangler.gateway.*.jsonc binds `MATRIX_GATEWAY` to this class.
export const { MatrixGatewayDO } = gateway;

export default {
  fetch: gateway.fetch,
  scheduled: gateway.scheduled,
};
