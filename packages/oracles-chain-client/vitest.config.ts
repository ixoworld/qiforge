import { mergeConfig } from '@ixo/vitest-config/base';
import config from '@ixo/vitest-config/nest';

export default mergeConfig(config, {
  test: {
    exclude: ['**/authz.test.ts', 'node_modules', 'dist'],
    // src/gql throws at import time when no endpoint is configured, and the
    // chain clients warn when no RPC URL is set. Unit tests never issue a
    // request, but the modules have to load quietly.
    env: {
      BLOCKSYNC_GRAPHQL_URL: 'http://localhost/graphql',
      RPC_URL: 'http://localhost/rpc',
    },
  },
});
