import { GraphQLClient } from 'graphql-request';
import { getSdk } from './generated/sdk.js';

/**
 * GraphQL endpoint URL for the IXO Blocksync API
 * This points to the testnet environment
 *
 * Note: dotenv.config() is not needed here as environment variables
 * are already loaded by the runtime (Next.js, Node.js, etc.)
 */
const GRAPHQL_ENDPOINT =
  typeof process !== 'undefined' && process.env
    ? process.env.BLOCKSYNC_GRAPHQL_URL || process.env.NEXT_PUBLIC_GRAPHQL_URL
    : undefined;
if (!GRAPHQL_ENDPOINT) {
  throw new Error(
    'BLOCKSYNC_GRAPHQL_URL or NEXT_PUBLIC_GRAPHQL_URL is not set',
  );
}

/**
 * GraphQL client instance configured with the IXO Blocksync endpoint.
 * Used internally by the SDK, and exported for narrowly-scoped raw queries
 * that would otherwise force a full SDK regeneration against a drifted
 * schema (e.g. `getSupportAccounts`).
 */
export const graphqlClient = new GraphQLClient(GRAPHQL_ENDPOINT);

/**
 * Type-safe SDK for making GraphQL requests to the IXO Blocksync API
 * This client provides auto-generated methods for all defined GraphQL operations
 */
export const gqlClient = getSdk(graphqlClient);

/**
 * Export all generated types from the GraphQL schema
 * This includes types for queries, mutations, and entity data structures
 */
export * from './generated/graphql.js';

export * from './gqlWrapper.js';
export { default as gql } from './gqlWrapper.js';
