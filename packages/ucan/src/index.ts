/**
 * @fileoverview @ixo/ucan - UCAN authorization for any service
 *
 * This package provides UCAN (User Controlled Authorization Networks) support
 * built on top of the battle-tested ucanto library.
 *
 * Features:
 * - Generic capability definitions (define your own)
 * - Framework-agnostic validator (works with Express, Fastify, etc.)
 * - Client helpers for creating delegations and invocations
 * - did:ixo resolution via IXO blockchain indexer (optional)
 * - In-memory invocation store for replay protection
 *
 * @example
 * ```typescript
 * // 1. Define your capabilities
 * import { defineCapability, createUCANValidator, generateKeypair } from '@ixo/ucan';
 *
 * const EmployeesRead = defineCapability({
 *   can: 'employees/read',
 *   protocol: 'myapp:'
 * });
 *
 * // 2. Create validator
 * const validator = createUCANValidator({
 *   serverDid: 'did:key:z6Mk...',
 *   rootIssuers: ['did:key:z6MkAdmin...'],
 * });
 *
 * // 3. Validate in your route (any framework)
 * app.post('/protected', async (req, res) => {
 *   const result = await validator.validate(req.body.invocation, {
 *     can: 'employees/read',
 *     with: 'myapp:employees'
 *   });
 *
 *   if (!result.ok) {
 *     return res.status(403).json({ error: result.error });
 *   }
 *
 *   res.json({ employees: [...] });
 * });
 * ```
 *
 * @packageDocumentation
 */

// =============================================================================
// Re-export ucanto packages for advanced usage
// =============================================================================

export * as UcantoServer from '@ucanto/server';
export * as UcantoClient from '@ucanto/client';
export * as UcantoValidator from '@ucanto/validator';
export * as UcantoPrincipal from '@ucanto/principal';
export { ed25519, Verifier } from '@ucanto/principal';

// =============================================================================
// Types
// =============================================================================

export type {
  IxoDID,
  KeyDID,
  SupportedDID,
  DIDKeyResolutionResult,
  DIDKeyResolver,
  InvocationStore,
  RevocationChecker,
  ValidationResult,
  SerializedInvocation,
} from './types.js';

// =============================================================================
// Capability Definition
// =============================================================================

export {
  defineCapability,
  Schema,
  type DefineCapabilityOptions,
} from './capabilities/capability.js';

// =============================================================================
// Validator
// =============================================================================

export {
  createUCANValidator,
  type CreateValidatorOptions,
  type ValidateResult,
  type UCANValidator,
} from './validator/validator.js';

// =============================================================================
// Client Helpers (for creating delegations and invocations)
// =============================================================================

export {
  generateKeypair,
  parseSigner,
  signerFromMnemonic,
  createDelegation,
  createInvocation,
  serializeInvocation,
  serializeDelegation,
  parseDelegation,
  getDelegationCid,
  type Signer,
  type Delegation,
  type Capability,
  type Fact,
} from './client/create-client.js';

// =============================================================================
// DID Resolution (optional, for did:ixo support)
// =============================================================================

export {
  createIxoDIDResolver,
  createCompositeDIDResolver,
  type IxoDIDResolverConfig,
} from './did/ixo-resolver.js';

export {
  createWebDIDResolver,
  type WebDIDResolverConfig,
} from './did/web-resolver.js';

export {
  createLocalDIDResolver,
  type LocalDIDResolver,
} from './did/local-resolver.js';

// =============================================================================
// Store (for replay protection)
// =============================================================================

export {
  InMemoryInvocationStore,
  createInvocationStore,
} from './store/memory.js';

// =============================================================================
// Revocation (checkers for the validator's revocationChecker option)
// =============================================================================

export {
  InMemoryRevocationStore,
  createUcanStoreRevocationChecker,
  type UcanStoreRevocationCheckerOptions,
} from './store/revocation.js';

// =============================================================================
// Version
// =============================================================================

export const VERSION = '2.2.0';
