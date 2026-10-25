# Portal wallet Flow catalog

Both runtimes pin the editor to Portal commit
`51650948f88c77bd16eb2c779be2b9b3213abdbb`, the source in
[Portal PR #2016](https://github.com/ixoworld/ixo-portal/pull/2016). The exact git
source is permitted to prepare its built package in `pnpm-workspace.yaml`.
BlockNote's server utility and Yjs are aligned with that editor. Replace the git
pin with the published editor version after its ordinary release; do not use a
floating branch or silently substitute a sibling installation.

Discovery derives category tags from canonical action names and fallback summary,
inputs and outputs from the registry. Hand-authored semantic integration metadata
remains useful, but a missing overlay no longer makes an action undiscoverable.
`list_actions` returns the installed registry version and manifest digest, so a
live test can identify the exact catalog contract. `describe_action` reports host service prerequisites and execution owner. Those
fields describe a contract, not verified live provider availability.

The old editor's `qi/payment.execute` action is absent from the current Portal
baseline. It operated payment-worklist rows. It is not a direct bank transfer,
and existing Flows using it must not be silently migrated. New direct transfers
use `qi/wallet.fund` with an explicit recipient, denom, exact base amount, and
optional authorized source; `qi/wallet.balance` provides read-only observations.
The human runs and signs in Portal. Balance lookup grants no spending authority.

The full action/Portal handler inventory, provider gaps and testnet checklist are
in `docs/audits/flow-action-catalog.md` in the Portal PR. Companion must pin the
matching QiForge revision before end-to-end testing. No package version or green
build establishes authenticated Topic binding, signing, broadcast, or receipt
acceptance; record those separately on testnet.

## Private editor access in CI

The CI and Workers harness jobs load `PORTAL_EDITOR_READ_KEY` through the pinned
SSH-agent action before installing packages. Its deploy-key comment routes only
the Portal repository through SSH, including the HTTPS URL in the frozen lockfile.
The key grants read-only access to `ixoworld/ixo-portal`; it has no write or deploy
authority. QiForge and Companion use separate keys held in repository secrets.
Local private-key files were deleted after verifying source access. Rotate by
replacing the consumer secret and revoking its matching Portal deploy key.
