# Direct organisation memory imports

The Workers runtime can accept reviewed organisation documents without starting an agent turn. Set `ORGANISATION_MEMORY_IMPORT_ENABLED=true` only after the deployed Memory Engine accepts the signed flow. Any other value leaves it off. Node runtime support is not included.

The public `GET /memory/imports/capabilities` descriptor reports the configured network (`NETWORK`, `mainnet` when unset, as everywhere else), oracle entity and account, limits, and `storageScope: "oracle"`. It reports disabled when the feature, identity or signing key is unavailable. An enabled descriptor is configuration evidence, not a claim that the provider is deployed or accepts writes. The existing environment signing mnemonic or Matrix account-room fallback supplies the oracle signer; each isolate asks the gateway for the account-room signer at most once every 5 minutes (30 seconds while none is found). The configured Memory plugin supplies `MEMORY_MCP_URL` through `core.validatedEnv`.

Portal resolves the current domain and oracle, displays the complete immutable text and target, and obtains the user's confirmation. It signs the exact UTF-8 body and sends it to one of two fixed paths:

| Path                          | Behavior                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /memory/imports`        | Admit a reviewed batch and return its durable receipt.                                                                                                                        |
| `POST /memory/imports/status` | Read a matching receipt without contacting Memory Engine or resuming work. Status reads do not re-read Blocksync or the oracle config, and spend their own rate-limit budget. |

Successful HTTP responses contain the receipt directly. A missing status receipt returns HTTP 404 with `{ "code": "not_found" }`. Other errors contain a bounded `code`. A timeout, disconnect or 503 after dispatch is uncertain and must not trigger an automatic POST retry. The Portal bridge wraps the HTTP receipt in its correlated typed result; it never gives the app credentials.

## Authorization

Each request needs an actual user-signed UCAN invocation addressed to `ORACLE_DID`, with only `{ can: "*", with: "ixo:oracle" }`, no proof chain, finite expiry within 90 seconds, and the `ixo.organisation-memory.invocation` fact binding operation, fixed path, exact body digest, original request digest, request ID, domain, oracle identities, network and caller. A bare delegation is refused even when legacy chat authentication is enabled. The Portal normally uses a 60 second invocation.

Submits also need a direct user-to-same-oracle delegation containing only `{ can: "memory/*", with: "ixo:memory" }`, expiring within 300 seconds (30 more are allowed for a client clock running ahead of the Worker). This is the least ability the current upstream accepts. It is not an upstream body-scoped grant. The request proof remains separate from the stored chat delegation and is never deposited as `META_DELEGATION`.

For a submit, the backend independently reads its configured Blocksync to check that the caller owns or controls the exact submitted domain and that the selected oracle is currently associated with it. Another domain attached to the same oracle does not confer this initial write right. It verifies the oracle's unique `oracleAuthZConfig` resource against the linked resource's raw SHA256 proof before accepting its `granteeAddress` as the configured oracle account. The proof is mandatory. Public HTTPS resources have bounded reads and refuse redirects. A domain or oracle entity that does not exist is a definite refusal (`exact_domain_control_required`, `not_an_oracle`), as is a config document that is not JSON (`oracle_account_mismatch`). The `oracleService` endpoint must be an origin, optionally with a trailing `/`, as the Portal accepts it. Account, entity and network must match the deployment, for status reads too.

The user Durable Object resolves the authenticated user-oracle Matrix room through the gateway. It does not boot the user's chat working copy, so an import needs no stored chat delegation. It uses the existing oracle signer and the request-local proof to mint a fresh downstream invocation with at most 60 seconds lifetime. A dedicated MCP client sends the fixed `add_oracle_knowledge` call once per chunk. It never replays an effect after HTTP failure, timeout, stream interruption or malformed acknowledgement. It does not bypass upstream authorization refusals. After a queued chunk the room's prefetched user context is dropped, as after a chat `add_oracle_knowledge` call.

Both visibility choices are oracle-wide. Public knowledge is shared with oracle users; private knowledge is available to users permitted by the Memory Engine access rules. Neither option creates a domain-private space.

## Receipts and replay protection

The maximum body is 262144 UTF-8 bytes, with 1–25 uniquely identified chunks of at most 12000 UTF-8 bytes each. Every submitted content hash is recomputed. Source hashes describe provenance; the content hash and exact raw body digest bind the actual text. See `src/organisation-memory/fixtures/v1.json` for the shared byte fixture.

The user Durable Object reserves the immutable request ID/digest and a dispatch marker before each effect. Its durable key includes configured oracle and authenticated caller. The ledger stores only scope metadata, chunk identifiers, hashes and outcomes. It retains receipts without silently deleting replay guards. It stores neither contents nor grants.

Duplicate requests return the saved receipt. A changed digest under the same ID returns HTTP 409. Concurrent copies share the admitted writer. Status never starts an import, and eviction does not resume one.

A `not_submitted` chunk without a `code` is still waiting for a running writer. Every final `not_submitted` carries a code: the preparation failure's own code (for example `memory_not_configured`, `user_room_unavailable`, `memory_initialize_failed`) when the import could not start, `memory_invocation_unavailable` when the downstream invocation could not be minted (nothing was sent), `batch_stopped` for chunks after the batch stopped, and `writer_interrupted` for chunks an interrupted writer never reached. A recovered dispatch marker becomes `unknown` with `dispatch_interrupted`.

`queued` means only that upstream returned `success: true` with an observed `queue_position`. It does not prove indexing or archival. Explicit refusals, including HTTP 429, are `rejected`, and the batch continues. A failure that leaves the effect uncertain is `unknown`, and the batch stops, as it does at a chunk it could not send. Operators must resolve uncertain writes with provider evidence before deciding on a new reviewed request; a status lookup is not a retry or reconciliation operation.

## Local validation

Run `pnpm --filter @ixo/oracle-runtime-workers test src/organisation-memory`. The Workers pool exercises real durable storage, real UCAN signatures with a local Blocksync key fixture, body/fact binding, exact-domain checks, proof tampering, concurrent duplicates, restart markers, partial outcomes, terminal chunk codes and one-dispatch MCP transport. These deterministic fixtures are not live provider acceptance or deployed recovery evidence.
