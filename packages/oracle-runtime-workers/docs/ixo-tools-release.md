# IXO Tools release evidence

Stage nine prepares a controlled read-only release under [ORA-843](https://linear.app/ixo-world/issue/ORA-843/give-companion-and-qiforge-agents-grounded-ixo-operating-context). This command reads files and Git state. It cannot deploy, enable a tool, register an OAuth resource, migrate Auth Hub, publish a capsule or approve a payment.

## Assess a release record

From this package, run with Node 22:

```sh
pnpm test:ixo-release
node scripts/check-ixo-release.mjs \
  --candidate release/ixo-candidate.example.json \
  --evidence release/ixo-evidence.empty.json \
  --source /absolute/path/to/exact-runtime-source \
  --network devnet
```

The example contains placeholder commits, hashes, CIDs and audiences. It deliberately returns **3**, with `INCOMPLETE`, missing gates and `deploymentAuthorized: false`. Replace every placeholder using reviewed artifacts before preparing a real candidate. The empty evidence file is a useful negative control, never acceptance evidence.

Exit **2** means malformed or unreadable inputs. Exit **3** means missing, changed or insufficient evidence. Exit **0** means `RECORDS_COMPLETE_FOR_REVIEW`. Every assessment retains `release: NOT_ESTABLISHED` and `deploymentAuthorized: false`. A complete unsigned record set is not live acceptance or permission to deploy. There is no approval switch or promotion command.

The output includes the observed gate digest. Pin that value as `gateSha256` in the candidate, then collect evidence against its new candidate digest. The gate digest binds this assessor, its CLI, the shared local conformance policy and the dependency lock. Changing any of those files invalidates the pin. Candidate hashing uses `JSON.stringify(candidateSchema.parse(input))`, so formatting and input key order do not affect the digest. The strict schema and versioned required-case vocabulary live in `scripts/ixo-release.mjs`.

## Candidate identity

The candidate binds the QiForge and Companion commits, six other source-owner revisions, runtime archive digest/version, catalog digest/version, provider-observed model and composed-prompt digest. It pins all ten read tools, all twelve stage-six public/private capsule candidates with author SHA, immutable CID, archive hash and previous CID. This version supports the full catalog release. Partial releases need a separately reviewed policy and matching prompt/catalog claims; deleting cases or modules does not waive a gate.

Each environment has a distinct canonical exact MCP resource, registered client IDs and rollback identifiers for both Worker scripts, config, runtime, Companion and Auth Hub policy. A rollback to a prior Companion bundle does not reverse Auth Hub migration 0030 or restore invalidated credentials. Plan forward recovery and client reauthorization separately. Archive download, hash verification and actual mounted CID must precede a skill acceptance record. An unpublished expected CID cannot satisfy the publication case.

## Evidence contract

`ixo-evidence.empty.json` is the root shape. `localConformance` references the exact stage-eight report. A reference is `{ "path": "private/artifact.json", "sha256": "<64 hex>" }`, relative to the evidence file's directory. Absolute paths, symlink escapes, traversal outside that directory and files above 16 MiB are refused. Keep traces private and split oversized captures under the authorized retention policy. The report prints no raw artifacts, credentials, final answers or host origins. It prints hashed artifact path identifiers and fixed case IDs.

The assessor re-evaluates the local report through the same critical-regression and thirty-pair comparison policy as `test:ixo-conformance`. It requires the exact source-path set, clean source Git head and matching file hashes. A stale, dirty or manually reduced report cannot pass merely because its status says PASS. The conformance driver and release assessor share the source-path list. The source checkout must be the exact runtime source named by the candidate, which can precede this standalone gate change.

Every hosted receipt has this shape. The example below describes the schema; it is not evidence:

```json
{
  "gate": "baseline",
  "network": "devnet",
  "candidateSha256": "<candidate digest>",
  "kind": "hosted",
  "observedAt": "<UTC ISO timestamp>",
  "subject": {
    "oracleVersion": "<deployed oracle Worker version>",
    "gatewayVersion": "<deployed gateway Worker version>",
    "configSha256": "<effective configuration digest>",
    "modelId": "<provider response model>",
    "promptSha256": "<composed prompt digest>",
    "runtimeSha256": "<runtime archive digest>",
    "catalogSha256": "<catalog digest>",
    "resource": "https://reviewed-host/v1/mcp",
    "clientIds": ["<registered client>"],
    "modules": ["<all candidate modules>"]
  },
  "cases": [
    {
      "id": "authenticated-build",
      "result": "PASS",
      "artifacts": [{ "path": "private/trace.json", "sha256": "<digest>" }]
    }
  ],
  "review": {
    "collector": "<collector identity>",
    "reviewer": "<different reviewer identity>",
    "reviewedAt": "<UTC ISO timestamp>",
    "decision": "ACCEPT",
    "attestation": { "path": "private/review.json", "sha256": "<digest>" }
  }
}
```

The attestation file must be JSON `{ "schemaVersion": 1, "receiptSha256": "<digest>", "reviewer": "<same reviewer>", "decision": "ACCEPT" }`. Compute `receiptSha256` with the exported `receiptDigest(receipt)`. It parses the receipt, removes only the attestation reference to avoid a circular hash, and hashes the remaining canonical JSON, including subject, case artifacts, review identity, decision and times. The gate verifies this binding. Edited receipts require a new review attestation. This format does not authenticate the reviewer or prove the attested facts.

Use every exact case ID from `REQUIRED_CASES`, once, in its owning gate. A receipt needs all its cases; the abbreviated example fails. Case status is PASS, FAIL, NOT_RUN or INCOMPLETE. Missing/skipped cases, duplicate gates or IDs, wrong candidate/network/subject, substituted artifact bytes, fixture-labelled evidence, self-review and pending decisions produce blockers. Subject Worker/config identities must agree across all receipts in an environment. Artifacts need independent semantic review, including authentic owner identity, room membership, current grants and source provenance. A distinct reviewer string alone cannot prove reviewer independence.

The eight gate families are:

| Gate     | Required observations                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| baseline | Authenticated build identity, complete Worker routing, source revisions and authority bindings. Public health is insufficient.                                                 |
| services | Owned account/network, confirmed credit zero versus outage, partial and unindexed file coverage, memory revocation, owned receipts and non-executable expired quotes.          |
| agent    | Eleven journeys across two real users and two actual oracles, 44 rows per network. This includes six original intents, two memory namespaces and three isolation/denial cases. |
| skills   | Published, mounted and executed archive for each of twelve pinned capsules, with current grants and dependencies.                                                              |
| oauth    | Resource/client binding, expiry/revocation, wrong audience/client, downstream narrowing, migration/reauthorization and current membership.                                     |
| clients  | Account, files, memory, quote, denial, reconnect and cancellation through native, actual ChatGPT and actual Claude clients.                                                    |
| rollback | Both Worker versions, module/ingress shutdown, capsule recovery, Auth Hub forward recovery and no financial writes.                                                            |
| canary   | Successful/refused reads, source outage, partial results and no critical failure.                                                                                              |

All local reports, observations and reviews must be within the preceding **24 hours** at assessment time; future times and review-before-observation are refused. The library takes an explicit evaluation time for deterministic tests; the CLI uses the current clock. Devnet assessment requires devnet evidence; testnet also requires devnet; mainnet requires all three. Each environment's accepted baseline must precede its other observations, and every gate review must precede that environment's final canary observation. Its accepted canary must precede the next environment's baseline. All records bind the same candidate. Changes to the candidate require new evidence. Re-run earlier environments if their evidence has expired.

## Operator sequence and rollback

After the source PRs merge under their existing review processes, a release owner must separately authorize and record a read-only canary deployment, controlled test actors and grants, exact service revisions, Auth Hub registration/migration and any capsule publication. Keep this preparation's Companion module lists empty and IXO MCP ingress absent. Companion's preparation lock refuses repository deployment paths until a later reviewed change replaces that boundary.

Run local and authenticated service gates, then the actual model and mounted-skill cases. Capture provider-response model metadata, the composed prompt, actual deployed Worker versions and effective audiences. The existing Companion capture runner creates sessions and may trigger other model tools; use a reviewed read-only deployment and explicit authorization before capture. Its 88-row two-network capture is structural observation only. A reviewer must map the target network's 44 rows and raw trace hashes into gate receipts and accept their semantics. `CAPTURED` is not PASS.

Run actual hosted-client, authority, rollback and canary cases on devnet. Assess records, have the release owner verify the unsigned attestations against the raw evidence, then authorize the next environment separately. Repeat for testnet and mainnet. Stop promotion on a critical failure, stale evidence, missing dependency, privacy leak, guessed balance or false financial success. Disable the affected modules/ingress, restore both reviewed Worker versions and prior CIDs where compatible, and retain the incident evidence. Never restore fabricated zero behavior or assume a Worker rollback undoes an external migration or dispatched work.

This gate does not authenticate attestations, inspect arbitrary trace semantics, contact hosted systems or control direct Wrangler/Cloudflare access. Hashes establish byte identity. Operator trust, authenticated collection, independent semantic review and deployment authorization remain separate requirements.
