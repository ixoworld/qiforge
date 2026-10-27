import { z } from 'zod';

/**
 * The Memory Engine keys every memory space by the oracle's domain entity
 * (`did:ixo:entity:<32 hex>`): the user's personal space is
 * `sha256(<userDid>-<entityDid>)` and the shared knowledge spaces are the
 * entity's. Every engine request names the entity in this header; the engine
 * refuses a request without it and checks (on chain) that the entity lists
 * the oracle's agent account as a Matrix admin.
 */
export const MEMORY_ENTITY_HEADER = 'x-oracle-entity-did';

/** The shape the Memory Engine accepts for {@link MEMORY_ENTITY_HEADER}. */
export const ORACLE_ENTITY_DID_PATTERN = /^did:ixo:entity:[0-9a-f]{32}$/;

const ENTITY_REQUIRED_MESSAGE =
  "ORACLE_ENTITY_DID is required by the memory plugin: set it to the oracle's domain entity DID (did:ixo:entity: followed by 32 lower-case hex characters). The Memory Engine keys every memory space by that entity and refuses requests without it.";

const ENTITY_SHAPE_MESSAGE =
  "ORACLE_ENTITY_DID must be the oracle's domain entity DID (did:ixo:entity: followed by 32 lower-case hex characters); the Memory Engine refuses any other value.";

/**
 * `ORACLE_ENTITY_DID` as the memory plugin requires it. The core schema keeps
 * the variable optional (rooms and feedback fall back to `ORACLE_DID`); the
 * memory plugin redeclares it so an oracle with `MEMORY_MCP_URL` and no
 * entity fails at boot. The engine never receives the `ORACLE_DID` fallback.
 */
export const oracleEntityDidSchema = z
  .string({
    error: (issue) =>
      issue.input === undefined
        ? ENTITY_REQUIRED_MESSAGE
        : ENTITY_SHAPE_MESSAGE,
  })
  .regex(ORACLE_ENTITY_DID_PATTERN, ENTITY_SHAPE_MESSAGE);

/**
 * The configured `ORACLE_ENTITY_DID` when it is a well-formed domain entity
 * DID, else `undefined`. For the engine paths outside the plugin (first-turn
 * prefetch, session-history indexing, the memory debug route): they read the
 * merged env directly and run wherever `MEMORY_ENGINE_URL` survives
 * validation, which another plugin than this one may declare, so the
 * plugin's schema does not cover them.
 */
export function memoryEntityDid(value: unknown): string | undefined {
  return typeof value === 'string' && ORACLE_ENTITY_DID_PATTERN.test(value)
    ? value
    : undefined;
}
