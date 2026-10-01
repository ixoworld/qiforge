# @ixo/ucan

A framework-agnostic UCAN (User Controlled Authorization Networks) implementation for any service. Built on top of the battle-tested [ucanto](https://github.com/storacha/ucanto) library and conforming to the [UCAN specification](https://github.com/ucan-wg/spec/).

## What is UCAN?

UCAN is a decentralized authorization system using cryptographically signed tokens. Think of it as "JWT meets capabilities" - users can grant specific permissions to others, who can further delegate (but never escalate) those permissions.

**Key concepts:**

- **Capabilities**: What actions can be performed on which resources
- **Delegations**: Granting capabilities to others (can be chained)
- **Invocations**: Requests to use a capability
- **Facts**: Verifiable claims attached to a delegation or invocation (scoped per-UCAN, not inherited)
- **Attenuation**: Permissions can only be narrowed, never expanded

📖 **[See the visual flow diagram →](./docs/FLOW.md)**

## Features

- 🔐 **Built on ucanto** - Battle-tested UCAN library from Storacha
- 🎯 **Generic Capabilities** - Define your own capabilities with custom schemas
- ⚙️ **Caveat Validation** - Enforce limits and restrictions on delegations
- 🌐 **Multi-DID Support** - `did:key` (native) + `did:ixo` (via blockchain indexer) + `did:web` (via HTTP) + local (in-memory registry)
- 🚀 **Framework-Agnostic** - Works with Express, Fastify, Hono, NestJS, etc.
- 🛡️ **Replay Protection** - Built-in invocation store prevents replay attacks
- ⛔ **Revocation** - Check every delegation in a verified proof chain against a revocation registry, in one batched call

## Installation

```bash
npm install @ixo/ucan
# or
pnpm add @ixo/ucan
```

## Quick Start

### 1. Define a Capability

```typescript
import { defineCapability, Schema } from '@ixo/ucan';

const EmployeesRead = defineCapability({
  can: 'employees/read',
  protocol: 'myapp:',
  nb: { limit: Schema.integer().optional() },
  derives: (claimed, delegated) => {
    const claimedLimit = claimed.nb?.limit ?? Infinity;
    const delegatedLimit = delegated.nb?.limit ?? Infinity;

    if (claimedLimit > delegatedLimit) {
      return {
        error: new Error(
          `Limit ${claimedLimit} exceeds allowed ${delegatedLimit}`,
        ),
      };
    }
    return { ok: {} };
  },
});
```

### 2. Create a Validator (Server)

```typescript
import { createUCANValidator, createIxoDIDResolver } from '@ixo/ucan';

const validator = await createUCANValidator({
  serverDid: 'did:ixo:ixo1abc...', // Your server's DID
  rootIssuers: ['did:ixo:ixo1admin...'], // DIDs that can issue root capabilities
  didResolver: createIxoDIDResolver({
    indexerUrl: 'https://blocksync.ixo.earth/graphql',
  }),
});
```

### 3. Protect a Route (Invocation)

```typescript
app.post('/employees', async (req, res) => {
  const result = await validator.validate(
    req.body.invocation, // Base64-encoded CAR
    EmployeesRead,
    'myapp:company/acme',
  );

  if (!result.ok) {
    return res.status(403).json({ error: result.error });
  }

  // result.invoker — DID of who made the request
  // result.capability — validated capability with caveats (nb)
  // result.expiration — earliest expiration across the delegation chain (undefined = never)
  // result.proofChain — delegation path from root to invoker, e.g. ["did:key:root", "did:key:user"]
  // result.facts — facts attached to the invocation (undefined if none)

  const limit = result.capability?.nb?.limit ?? 10;
  res.json({ employees: getEmployees(limit) });
});
```

### 3b. Validate a Delegation

Use `validateDelegation()` to verify a standalone delegation token — e.g. when a client sends a delegation in a header alongside a traditional auth mechanism. This verifies the cryptographic signature chain, audience, and expiration without requiring a capability definition.

```typescript
app.use(async (req, res, next) => {
  const delegationHeader = req.headers['x-ucan-delegation'];
  if (!delegationHeader) return next();

  const result = await validator.validateDelegation(delegationHeader);

  if (!result.ok) {
    console.warn(
      `Delegation invalid: [${result.error?.code}] ${result.error?.message}`,
    );
    return next();
  }

  // result.invoker — issuer DID (who granted the delegation)
  // result.capability — first capability in the delegation
  // result.expiration — effective expiration across the proof chain
  // result.proofChain — e.g. ["did:ixo:root", "did:ixo:user"]

  req.ucanDelegation = {
    issuer: result.invoker,
    capability: result.capability,
    expiration: result.expiration,
  };

  next();
});
```

### 4. Create & Use a Delegation (Client)

```typescript
import {
  generateKeypair,
  createDelegation,
  createInvocation,
  serializeInvocation,
} from '@ixo/ucan';

// Generate a keypair for the user
const { signer, did } = await generateKeypair();

// Root creates a delegation for the user
const delegation = await createDelegation({
  issuer: rootSigner,
  audience: did,
  capabilities: [
    { can: 'employees/read', with: 'myapp:company/acme', nb: { limit: 50 } },
  ],
  expiration: Math.floor(Date.now() / 1000) + 3600, // 1 hour
});

// User creates an invocation
const invocation = await createInvocation({
  issuer: signer,
  audience: serverDid,
  capability: {
    can: 'employees/read',
    with: 'myapp:company/acme',
    nb: { limit: 25 },
  },
  proofs: [delegation],
});

// Serialize and send
const serialized = await serializeInvocation(invocation);
await fetch('/employees', {
  method: 'POST',
  body: JSON.stringify({ invocation: serialized }),
});
```

## Documentation

| Document                                                  | Description                                          |
| --------------------------------------------------------- | ---------------------------------------------------- |
| **[Flow Diagram](./docs/FLOW.md)**                        | Visual explanation of UCAN delegation and invocation |
| **[Server Example](./docs/examples/SERVER.md)**           | Complete Express server with protected routes        |
| **[Client Example](./docs/examples/CLIENT.md)**           | Frontend/client-side usage                           |
| **[Capabilities Guide](./docs/examples/CAPABILITIES.md)** | How to define custom capabilities with caveats       |

## API Reference

### Capability Definition

```typescript
defineCapability(options: DefineCapabilityOptions)
```

Define a capability with optional caveat validation.

| Option     | Type       | Description                            |
| ---------- | ---------- | -------------------------------------- |
| `can`      | `string`   | Action name (e.g., `'employees/read'`) |
| `protocol` | `string`   | URI protocol (default: `'urn:'`)       |
| `nb`       | `object`   | Schema for caveats using `Schema.*`    |
| `derives`  | `function` | Custom validation for attenuation      |

### Validator

```typescript
createUCANValidator(options: CreateValidatorOptions): Promise<UCANValidator>
```

Create a framework-agnostic validator.

| Option              | Type                 | Description                                                               |
| ------------------- | -------------------- | ------------------------------------------------------------------------- |
| `serverDid`         | `string`             | Server's DID (any method supported)                                       |
| `rootIssuers`       | `string[]`           | DIDs that can self-issue capabilities                                     |
| `didResolver`       | `DIDKeyResolver`     | Resolver for non-`did:key` DIDs                                           |
| `invocationStore`   | `InvocationStore`    | Custom store for replay protection                                        |
| `revocationChecker` | `RevocationChecker`  | Check the verified proof chain against a revocation registry (see below)  |
| `revocationFailure` | `'open' \| 'closed'` | What to do if the checker itself fails. Default `'closed'`                |
| `requireExpiration` | `boolean`            | Reject tokens with unbounded expiry. Default `false`; recommended in prod |

#### Methods

| Method                                                | Description                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| `validate(invocationBase64, capabilityDef, resource)` | Validate an invocation against a capability definition        |
| `validateDelegation(delegationBase64)`                | Validate a standalone delegation (signature, audience, chain) |

**`validate()`** validates a full invocation — checks signature, capability matching, caveats, replay protection, and resource authorization.

**`validateDelegation()`** validates a standalone delegation token — verifies the cryptographic signature of every delegation in the proof chain, checks audience matches `serverDid`, validates expiration, and ensures chain consistency (each proof's audience matches the child delegation's issuer). Supports `did:key` issuers natively and non-`did:key` issuers (e.g. `did:ixo`) via the configured `didResolver`.

#### `ValidateResult`

Both methods return a `ValidateResult`:

| Field            | Type                                     | Description                                                                                          |
| ---------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ok`             | `boolean`                                | Whether validation succeeded                                                                         |
| `invoker`        | `string`                                 | DID of the invoker/issuer (on success)                                                               |
| `capability`     | `object`                                 | Validated capability with `can`, `with`, and optional `nb` caveats (on success)                      |
| `expiration`     | `number \| undefined`                    | Effective expiration (Unix seconds) — the earliest across the delegation chain. Undefined = never.   |
| `proofChain`     | `string[] \| undefined`                  | Delegation path from root issuer to invoker, e.g. `["did:key:root", "did:key:alice", "did:key:bob"]` |
| `proofChainCids` | `string[] \| undefined`                  | Canonical CIDs of the verified chain, parents first (the invocation's own CID is last)               |
| `facts`          | `Record<string, unknown>[] \| undefined` | Facts attached to the invocation/delegation. Undefined if none.                                      |
| `error`          | `object`                                 | Error with `code` and `message` (on failure)                                                         |

Error codes: `INVALID_FORMAT`, `INVALID_SIGNATURE`, `UNAUTHORIZED`, `REPLAY`, `EXPIRED`, `CAVEAT_VIOLATION`, `REVOKED`, `REVOCATION_CHECK_FAILED`.

### Revocation

Short TTLs are the first line of defence; revocation is the manual override for a delegation that
must die before it expires. Following the
[UCAN revocation spec](https://github.com/ucan-wg/revocation), a revocation targets the **canonical
CID of one exact delegation** and is **irreversible** — to restore access you issue a _new_
delegation, never an un-revoke.

Supply a `revocationChecker` and the validator collects the CIDs of the invocation and of every
delegation in the **cryptographically verified** proof chain, then checks them all in **one**
batched call. Any hit fails validation with `REVOKED`.

```typescript
import {
  createUCANValidator,
  createUcanStoreRevocationChecker,
} from '@ixo/ucan';

const validator = await createUCANValidator({
  serverDid,
  rootIssuers: ['*'],
  didResolver,
  revocationChecker: createUcanStoreRevocationChecker({
    url: 'https://store.ucan.ixo.earth',
  }),
  // 'closed' (default) rejects when revocation status can't be determined.
  revocationFailure: 'closed',
});
```

`createUcanStoreRevocationChecker` queries an `ixo-ucan-store` worker and caches on the grain of
the spec's guarantees: because revocation is irreversible a **revoked** verdict is cached forever
(and short-circuits the request entirely), while a **clean** verdict is trusted only for
`negativeCacheTtlMs` (default 30 s). Options: `url`, `fetchImpl`, `timeoutMs` (1500),
`negativeCacheTtlMs` (30 000), `maxBatch` (32), `cacheMaxEntries` (10 000).

Any object with a `check(cids: string[]): Promise<string[]>` method works — return the revoked
subset. `InMemoryRevocationStore` is provided for tests and single-process use:

```typescript
import { InMemoryRevocationStore } from '@ixo/ucan';

const revocations = new InMemoryRevocationStore();
revocations.revoke(await getDelegationCid(delegation));
```

The checker **throwing** means "status unknown" and triggers your `revocationFailure` policy;
returning an array means the answer is authoritative. The check runs _before_ the replay marker is
written, so a rejected or unverifiable request never burns an invocation's single-use slot.

### Client Helpers

| Function                             | Description                               |
| ------------------------------------ | ----------------------------------------- |
| `generateKeypair()`                  | Generate new Ed25519 keypair              |
| `parseSigner(privateKey, did?)`      | Parse private key into signer             |
| `signerFromMnemonic(mnemonic, did?)` | Derive signer from BIP39 mnemonic         |
| `createDelegation(options)`          | Create a delegation                       |
| `createInvocation(options)`          | Create an invocation                      |
| `serializeDelegation(delegation)`    | Serialize to base64 CAR                   |
| `serializeInvocation(invocation)`    | Serialize to base64 CAR                   |
| `parseDelegation(serialized)`        | Parse from base64 CAR                     |
| `getDelegationCid(delegationOrCar)`  | Canonical CID — what a revocation targets |

> **Note:** Both `createDelegation` and `createInvocation` default to `expiration: Infinity` (never expires) when no expiration is specified. Pass an explicit Unix timestamp (seconds) to set an expiration. A never-expiring token can only ever be neutralized by a revocation record that must then be kept forever — set `requireExpiration: true` on production validators to refuse them.

`getDelegationCid` accepts a live `Delegation` **or** its serialized base64 CAR and returns the
same canonical string either way (`CIDv1(dag-cbor, sha2-256)`, base32 — `bafyrei…`). Keep it after
minting a delegation so you know what to revoke later.

#### Facts

Both `createDelegation` and `createInvocation` accept an optional `facts` parameter — an array of `Record<string, unknown>` objects representing verifiable claims or proofs of knowledge ([UCAN spec §3.2.4](https://github.com/ucan-wg/spec/#324-facts)).

```typescript
const invocation = await createInvocation({
  issuer: signer,
  audience: serverDid,
  capability: { can: 'oracle/call', with: 'ixo:oracle:123' },
  proofs: [delegation],
  facts: [{ requestId: 'abc-123', origin: 'portal' }],
});
```

> **Important:** Facts are scoped per-UCAN. Each delegation and invocation carries its own independent `fct` field. Facts on a delegation do **not** propagate to invocations that use it as a proof. The `facts` field in `ValidateResult` contains only the facts from the invocation itself.

### DID Resolution

```typescript
createIxoDIDResolver(config: IxoDIDResolverConfig): DIDKeyResolver
createWebDIDResolver(config?: WebDIDResolverConfig): DIDKeyResolver
createLocalDIDResolver(): LocalDIDResolver
createCompositeDIDResolver(resolvers: DIDKeyResolver[]): DIDKeyResolver
```

#### `createIxoDIDResolver`

Resolves `did:ixo` identifiers by querying the IXO blockchain indexer for verification keys.

| Option       | Type     | Description                                |
| ------------ | -------- | ------------------------------------------ |
| `indexerUrl` | `string` | Blocksync GraphQL endpoint for DID lookups |

#### `createWebDIDResolver`

Resolves `did:web` identifiers by fetching the DID document from `https://{domain}/.well-known/did.json` (or path-based equivalents) and extracting Ed25519 verification methods.

| Option           | Type       | Description                                                                                |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `fetch`          | `function` | Custom fetch implementation (default: `globalThis.fetch`)                                  |
| `fallbackToHttp` | `boolean`  | Retry with `http://` when `https://` fails (default: `false`). Localhost always uses HTTP. |

#### `createLocalDIDResolver`

Creates a DID resolver backed by an in-memory registry of pre-known keys. Useful for services that know their own `did:web` identity at startup and want to avoid network calls for self-resolution.

```typescript
const localResolver = createLocalDIDResolver();
localResolver.register(
  'did:web:myservice.example.com',
  'z6MkPublicKeyMultibase...',
);

const didResolver = createCompositeDIDResolver([
  localResolver, // check local first (instant)
  createWebDIDResolver(), // fall back to HTTP
  createIxoDIDResolver({ indexerUrl: '...' }),
]);
```

| Method                              | Description                                            |
| ----------------------------------- | ------------------------------------------------------ |
| `register(did, publicKeyMultibase)` | Register a DID with its z-base58btc Ed25519 public key |

#### `createCompositeDIDResolver`

Chains multiple resolvers. Tries each in order — returns the first successful result or the last error if all fail.

### Replay Protection

```typescript
new InMemoryInvocationStore(options?)
createInvocationStore(options?)
```

## DID Support

| DID Method | Support         | Notes                                                    |
| ---------- | --------------- | -------------------------------------------------------- |
| `did:key`  | ✅ Native       | Parsed directly from the identifier                      |
| `did:ixo`  | ✅ Via resolver | Resolved via IXO blockchain indexer                      |
| `did:web`  | ✅ Via resolver | Fetches DID document from well-known endpoint            |
| Local      | ✅ In-memory    | Pre-registered keys resolved instantly, no network calls |

## Environment Variables

```env
# For IXO DID resolution
BLOCKSYNC_GRAPHQL_URL=https://blocksync.ixo.earth/graphql
```

## Advanced Usage

### Re-exported ucanto Packages

For advanced use cases, you can access the underlying ucanto packages:

```typescript
import {
  UcantoServer,
  UcantoClient,
  UcantoValidator,
  UcantoPrincipal,
  ed25519,
  Verifier,
} from '@ixo/ucan';
```

### Custom Invocation Store

Implement the `InvocationStore` interface for distributed deployments:

```typescript
interface InvocationStore {
  has(cid: string): Promise<boolean>;
  add(cid: string, ttlMs?: number): Promise<void>;
  cleanup?(): Promise<void>;
}
```

## Testing

```bash
pnpm test          # Run unit tests (vitest)
pnpm test:ucan     # Run interactive test script with full UCAN flow
```

The unit tests cover proof chain construction, expiration computation, facts pass-through, validation failures, caveat enforcement, replay protection, and delegation validation (signature verification, audience checks, expiration, tampered signatures, proof chain consistency, and `did:ixo` support).

## License

MIT

## Links

- [ucanto (underlying library)](https://github.com/storacha/ucanto)
- [UCAN Specification](https://github.com/ucan-wg/spec/)
- [IXO Network](https://www.ixo.world/)
