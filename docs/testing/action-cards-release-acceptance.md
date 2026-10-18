# Action-card release acceptance

[IXO-5618](https://linear.app/ixo-world/issue/IXO-5618/publish-compatible-action-card-packages-and-prove-live-acceptance) and parent IXO-5609 remain open. Both preparation flags remain false or absent. This record does not authorize deployment, signing, WhatsApp messages or activation.

The [machine-readable evidence ledger](action-cards-release-evidence.json) records source revisions, planned versions, observed checks and unfulfilled live gates. It is an evidence index, not a release attestation. To list the open gates without contacting a service:

```sh
node --input-type=module -e 'import {readFileSync} from "node:fs"; const e=JSON.parse(readFileSync("docs/testing/action-cards-release-evidence.json","utf8")); const open=e.gates.filter(g=>g.status!=="passed"); for(const g of open) console.log(`${g.id}: ${g.needs}`); process.exitCode=open.length ? 1 : 0;'
```

## Source verification on 2026-10-18

The inherited POD assertion incorrectly treated `MsgSend` as unsupported. The corrected test distinguishes an unsupported type, a malformed supported transfer and a valid transfer forbidden in a POD creation batch. Runtime validation is unchanged.

The rebuilt common package and Workers source passed 2,237 workerd tests in 189 files. Independent review then found a mixed-marker Cloudflare envelope that could discard a failed inference state. After that correction, 164 action/provider/POD workerd tests, 895 core tests and 198 shared Decision tests passed. Common build, Workers type check, changed-file lint and formatting passed. Independent review rechecked the correction with no remaining actionable findings. Remote bindings were disabled in workerd tests.

A real Cloudflare call exposed the nested `success/result/{state: Completed,result}` response. ORA-810 adds completed-envelope normalization for REST and Workers AI and rejects other states. A fixed-source synthetic call returned HTTP 200, boolean 0.98 and bounded choice `requested`. Choice confidence 0.78 and requested probability 0.89 fall below the unchanged 0.95 policy. The correct preparation outcome is clarification. No proposal was prepared. The ledger distinguishes the live-tested file hash from subsequent locally verified mixed-marker hardening.

All deployed Companion environments select `openrouter-jev`. Its real-call gate remains open under ORA-511. Cloudflare normalization evidence does not satisfy selected-provider acceptance, representative intent accuracy, trusted target resolution or authorization.

Upstream main was refreshed to `baec324161c0f3be5d284e28ee3272e261102a3c` and is already an ancestor of this candidate. The implementation remains stacked on [runtime PR 363](https://github.com/ixoworld/qiforge/pull/363). Matching consumers are [Portal PR 1951](https://github.com/ixoworld/ixo-portal/pull/1951) and [gateway PR 16](https://github.com/ixoworld/ixo-channel-gateway/pull/16), including their parent PRs. Experimental Portal PR 1947 remains a separate prerequisite. These PRs were open and unmerged at inspection.

## Package and deployment gate

The public `@ixo/ixo-transaction` 0.1.0 and Workers 0.19.0 archives lack proposal support. Source with the same version string is not interchangeable with those registry packages. Changesets plans transaction 0.2.0, common 1.7.1 and Workers 0.20.0, plus dependent Node runtime 1.99.2 and private example bumps. Recompute the plan against refreshed upstream immediately before release. No package was published.

Portal currently uses the reviewed transaction archive with SHA-256 `38e624fc1dfc693aad61ff55d9fa6b93de5aece22fce2f51a2eac6785dea701b`, built from runtime base `2ddc380ba8adc2e815eff86d221b31791da829dd`. Replacing it requires a matching published package, regenerated frozen lockfile and the same consent/encoding checks. Do not replace it with public 0.1.0.

Live versions observed through read-only Cloudflare APIs:

| Surface                 | Active version                         | Build/provider             |
| ----------------------- | -------------------------------------- | -------------------------- |
| Companion devnet        | `3141cc06-5157-4a92-8cc6-a13602f00a37` | 0.19.0 / openrouter-jev    |
| Companion testnet       | `e993c383-ca10-4de2-b7f2-469e22774e07` | 0.19.0 / openrouter-jev    |
| Companion mainnet       | `cc6fe9ac-b46f-4612-beef-ed0c91db10f7` | 0.19.0 / openrouter-jev    |
| Matrix gateway devnet   | `c7df8ae0-6000-40f9-99d7-255f1a09dc10` | Existing gateway           |
| Channel gateway mainnet | `5b9cd9ba-1dfb-4a5c-8386-cbe4895a8533` | Existing enabled transport |

Both preparation bindings are absent in all three Companion versions. The new source defaults them to false. The channel gateway also lacks the trusted action-review Portal origin. Version metadata does not attest the deployed Git source. Public health and nonexistent-proposal requests returned perimeter HTTP 403, so they provide no owner-authentication evidence.

An isolated Companion candidate based on `cc151dafdbd2e4534eb01e3ca426ee5d371ebcf9` was prepared with planned Workers 0.20.0 and bot SDK 0.7.0 pins, explicit `openrouter-jev`, both flags false, and proposed review origin `https://test.portal.qi.space`. Local source dependencies were linked for the build. This is not a registry or frozen-install proof. Adoption also requires moving the existing observe-only `domainContext` settings from `OracleConfig` into the actual worker option; the original placement fails type checking. The corrected local candidate passes type checking and its two tests. A dry-run bundle performs no deployment. Keep the candidate local until published dependencies, lockfile, exact configuration and operator review are complete.

## Live execution sequence

1. Verify OpenRouter through an operator-controlled non-production Decision-only call using its existing secure binding. Record model, returned provenance, bounded answers and safe errors. Run versioned explicit, ambiguous, negated, quoted, incomplete and unsupported fixtures. Provider faults must clarify. Do not lower thresholds to manufacture acceptance.
2. Publish and adopt the approved compatible package graph. Record source commits, tarball hashes, frozen installs, Worker versions, trusted Portal origin and exact Portal deployment. Recheck the ledger after any source or deployment change. Deployments require the operator approval recorded by IXO-5618; preparation stays disabled.
3. Identify an approved devnet/testnet test owner, encrypted Matrix room, existing wallet, actual entity NFT ownership and dedicated WhatsApp test binding. The active production gateway is mainnet, which this preparer rejects. Do not repurpose the production number or invent a replacement identity.
4. Resolve a controlled live-test method with the operator before proposal creation. Ordinary preparation cannot run while both flags remain disabled. Any isolated acceptance-only exception would need explicit authorization and must not activate general preparation. No such exception was authorized in this run.
5. Follow the existing [channel harness](channels-acceptance.md). `--check-config` performs no network request; this run stops at missing `CHANNEL_GATEWAY_URL`. Its normal mode sends messages and revokes its test binding. Obtain explicit authorization for that dedicated test transport and use the existing secure account export. Never paste credentials into an issue or manufacture an account.
6. Exercise transfer, discussion creation and access grants from Portal and WhatsApp. Open only the friendly `/a/<opaque-id>` link, preserve login continuation, compare displayed values to exact execution messages, and hand real wallet confirmation to the owner. Verify chain receipts or all canonical Matrix effect events before success.
7. Exercise every security and recovery gate in the ledger on that deployed candidate. Record evidence references, not secrets, phone numbers or private conversation bodies. Preserve unknown outcomes and reconcile references without re-signing or blindly retrying writes.
8. Record cold and warm opening times and Decision latency with network, device, sample count and timing boundaries. Review mobile screenshots and recordings with the operator. Verify reads, reconciliation and receipts while preparation is disabled. IXO-5618 and IXO-5609 stay open until all gates pass; activation remains a separate action.

## Browser evidence limit

The Portal PR's published preview opened a synthetic friendly action URL at the sign-in screen. No signing or action execution was triggered. An authenticated return to the same proposal, real wallet round trip and WhatsApp-opened review remain unverified. Successful Vercel build statuses and earlier local consent screenshots do not close these gates.
