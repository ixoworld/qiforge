# POD‑06: Approval gate + network safety

**Phase:** 3 — Creation
**Spec:** §8, §10
**Effort:** 2 days
**Depends on:** POD‑05
**Blocks:** POD‑07

## Goal

The mandatory **whole‑batch, in‑chat** human‑approval gate before any signature handoff, plus
network‑safety defaults.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/pod-creator/approval.ts` — propose → approve → commit
  sequencing: `prepare_pod_transaction` (propose) presents the batch; an explicit user approval is
  required; only then may `request_pod_signature` (commit) fire for that same `blobId`. Stale or
  mismatched approvals are rejected.
- Network safety: default the `NETWORK` rollout to testnet; require an explicit `mainnet` opt‑in flag
  (`configSchema`) before a mainnet batch can be prepared.
- Tests.

## Acceptance

- [ ] `request_pod_signature` refuses to run without a matching prior approval for that `blobId`.
- [ ] Approval is whole‑batch and single‑use; re‑preparing a batch invalidates a prior approval.
- [ ] On mainnet without the opt‑in flag, `prepare_pod_transaction` refuses with a clear message.
- [ ] Test: an unapproved write is blocked; an approved write proceeds; a tampered batch (changed `blobId`) is rejected.

## Out of scope

- Step‑by‑step or out‑of‑band approver flows — decided against (§3, decision 4).
- A LangGraph core interrupt — not needed; the tool‑sequence gate suffices.

## Notes

- The wallet signature is the second gate; this in‑chat approval is the first. Two layers protect
  every write.
