# Reporter profile

The host must enable this profile explicitly:

```ts
createOracleWorker({
  config,
  plugins,
  reporter: { profile: 'reporter-grounded-v1' },
});
```

`ReporterProfileOptions` is exported from the package. Other oracles have no Reporter routes by default. The release changeset requests a minor release after review. This source change does not publish a package, update Companion's package pin or deploy a Worker.

## Requests and authority

All routes use the existing user Durable Object. Send a user-signed authentication invocation in `Authorization: Bearer …`, `X-Auth-Type: ucan`, and a separate `X-UCAN-Delegation` grant. The invocation and grant expire within 60 seconds. The grant contains exactly `fs/list`, `fs/read`, `fs/write` and `fs/delete` on `ixo:filesystem/.oracles`, with `nb.hidden: ['/.oracles']`. Auth Hub checks the current account, consent and lease before issuing these artifacts.

The request's delegation is held in asynchronous request context. It never replaces or deletes the user's shared Portal delegation. Owner reads and synchronous flushes use that local grant. A failed Reporter flush does not schedule a background retry using Portal rights. A fresh authenticated lookup can finish owner persistence.

Before serving Reporter, the runtime requires authenticated VFS confirmation from `GET /v1/reporter/owner-state-policy`:

```json
{ "version": 1, "privateOwnerState": true, "root": "/.oracles" }
```

The VFS deployment must enforce permanent privacy for this subtree, including existing files and later ancestor changes. A hidden filename alone is insufficient. A missing policy endpoint, unavailable signing key or legacy Matrix owner store fails closed before a Reporter snapshot is written.

## HTTP contract

| Method | Path                                                    | Behavior                                                                                                                  |
| ------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/reporter/capabilities`                                | Credential availability, skill identity and `platformCredits: false`. No inference.                                       |
| POST   | `/reporter/sessions`                                    | Create or recover an immutable snapshot session using `requestId`.                                                        |
| GET    | `/reporter/session-requests/:requestId`                 | Recover the session creation response after a dropped response.                                                           |
| GET    | `/reporter/sessions/:sessionId`                         | Snapshot and the latest 100 runs, in order.                                                                               |
| POST   | `/reporter/sessions/:sessionId/turns`                   | Reserve the request before inference. Active results return 202.                                                          |
| GET    | `/reporter/sessions/:sessionId/turns/:requestId`        | Recover the original durable run.                                                                                         |
| POST   | `/reporter/sessions/:sessionId/turns/:requestId/cancel` | Abort the current provider transport where possible. Active work becomes uncertain; a completed result remains completed. |

The strict wire schemas live in `src/reporter/contracts.ts`. Both request boundaries stop reading at 256 KiB. Snapshot digests hash recursively sorted JSON object keys, retaining array order, without the snapshot's `digest` field. Facts have nullable units. References are exact node/property pairs. Model output may copy exact facts, cite interpretations, or use the fixed missing-information phrase. The runtime rejects invented values and references.

Each run includes the immutable original `message` and `history`. History contains at most eight prior completed message/narrative pairs and occupies at most 64 KiB. The skill input digest hashes canonical `{snapshot,message,history}`. The output digest hashes the accepted narrative. Imported state is schema-checked. The question, evidence strings and history are untrusted input to the model.

## Inference and recovery

The SQL reservation keys user, session and request ID to a payload digest. A repeated ID with different input returns 409. A repeated identical request returns its existing run; it never schedules inference again. Both the reservation and the transition to running must reach owner persistence before the provider call. On a process restart, unfinished records become uncertain. A changed upstream owner file containing Reporter history requires reconciliation instead of silently replacing local request identities.

The bundled `SKILL.md` has version `1.0.0`. Its packaged string is checked byte-for-byte against the reviewed file. The handler calls the selected BYO model with JSON-schema output and zero automatic retries. It binds no generic tools, sandbox, network research or publishing. Factual validation happens after model generation. Actual provider model and token usage come from the response. Missing metadata or an unknown provider outcome remains uncertain. A response rejected by source validation retains its available execution and skill receipts.

There is no platform inference fallback. Missing credentials, unconfigured models, owner persistence failure and platform-credit funding all fail before inference. Capabilities report connected BYO credentials, not a live provider availability guarantee. Provider-specific structured-output acceptance still needs a real-account gate for each model enabled in production. Platform credits remain disabled until an actual reservation and settlement service is integrated.

Reporter sessions share the user's SQLite owner file but stay out of the generic Portal session picker. Generic turn execution rejects their profile. Existing Portal handoff remains separate; this change does not make the Portal generic transcript renderer understand Reporter narratives.

## Validation and release gates

Focused tests cover real workerd SQLite persistence and reopening, concurrent duplicates, changed payloads, session-creation recovery, source hashes, wrong owners, unsupported fields, missing credentials, unavailable credit funding, cancellation and bounded history. The skill suite drives the real BYO client over a simulated HTTP response and checks its actual model, source, JSON schema and receipts. Cryptographic auth tests reject malformed, expired, foreign-user and wrong-audience raw delegations before any room-state or cache mutation. The owner privacy probe and chunked request limit have explicit regressions.

These tests use synthetic evidence and simulated provider responses. They do not establish production provider reachability, credit settlement, Matrix bootstrap or live private VFS persistence. Runtime publication, Companion repinning and opt-in, Auth Hub/VFS rollout and a real authenticated user turn remain required release gates.

Tracking: IXO-5167 covers request and funding recovery; IXO-5184 covers raw delegation validation; IXO-5176 remains the real platform-credit settlement gate.
