# POD‑05: Create path (prepare → sign → confirm)

**Phase:** 3 — Creation
**Spec:** §7, §8, §11
**Effort:** 4 days
**Depends on:** POD‑03, POD‑04
**Blocks:** POD‑06

## Goal

The on‑chain create path: build the **unsigned** transaction batch from the approved blueprint, hand
it to the user's wallet via the AG‑UI action, and confirm the created POD. The oracle never signs
creation.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/pod-creator/tx-builder.ts` — compose the batch:
  `MsgCreateEntity` (the POD domain) + claim‑collection creation (**net‑new message builder**) +
  authz/UCAN grants, from the `service_pod_blueprint`. Encode to an **unsigned** `SignDoc` / `TxBody`.
  No broadcast.
- `packages/oracle-runtime/src/plugins/pod-creator/create-tools.ts`:
  - `prepare_pod_transaction` — build the batch; stash bytes in `ctx.blobStore`; return a
    human‑readable summary + estimated cost + `blobId`.
  - `request_pod_signature` — emit the `sign_transaction` AG‑UI action (`ctx.emit.actionCall`)
    referencing the `blobId`; block for the client's result (the `callAgAction` wait pattern).
  - `confirm_pod_creation` — `getTxByHash` → `getEntityIdFromTx` → `getEntityById` until the entity
    resolves; return the POD DID + summary.
- Tests (mock chain client + AG‑UI action + `blobStore`).

## Acceptance

- [ ] `prepare_pod_transaction` returns an unsigned batch (no signature, no broadcast) + a `blobId`; raw tx bytes are **not** in the LLM‑visible payload.
- [ ] Create tools are unavailable until `qa_launch_readiness` passes (gated).
- [ ] `request_pod_signature` emits the action and resolves on the client's `{ txHash }` (mocked).
- [ ] `confirm_pod_creation` parses the entity DID from the tx and reads it back.
- [ ] The net‑new claim‑collection message encodes and validates against the SDK types.

## Out of scope

- The approval‑gate UX + safety flags (POD‑06).
- A client‑side wallet — the Portal provides it (§10).

## Notes

- Model the structure on the credits on‑chain skeleton
  (`plugins/credits/claim-processing.service.ts`), but **prepare‑unsigned**, not oracle‑sign.
- Confirm the exact `MsgCreateEntity` owner fields so the POD is owned by the user from creation (§3, decision 3).
