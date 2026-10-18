# Durable conversational topic actions

ORA-809 extends the existing action proposal flow with standard discussion draft creation and claim-access grants. Existing transfer proposals retain v1 schemas and digests. Topic proposals use v2 and the `action-proposal/v2` digest namespace.

Both `ACTION_PROPOSALS_ENABLED` and `ACTION_TOPIC_PROPOSALS_ENABLED` must be `true` to prepare a topic action. Both default to `false`. Keep them disabled until IXO-5618 records the real end-to-end acceptance evidence. Disabling preparation preserves authenticated reads, reconciliation and receipts for existing proposals. This source change does not deploy or activate a capability.

## Authority and execution

QiForge extracts a bounded candidate from current human conversation evidence and uses Decisions to evaluate that interpretation. Deterministic code validates schemas, resolves identities and reads current authority. Incomplete, unsupported or ambiguous inputs require clarification.

The owner Durable Object stores the immutable proposal, exact digest, conversation origin and effect journal. Portal obtains explicit consent and claims the proposal. Before every new effect, QiForge rechecks the pinned authority and atomically records a one-use permit. Portal executes through its existing owner Matrix account or wallet. Bot credentials are used for passive evidence reads and cannot act as the owner's signing authority.

```text
validated candidate + trusted context
  durable immutable proposal
  owner review and claim
  fresh authority check
  durable one-use step permit
  existing Portal repository or wallet
  independently verified event references or transaction hash
  durable receipt to originating conversation
```

An effect that has started never becomes pending again. A missing permit response, Matrix response, wallet response or reconciliation response preserves uncertainty. Reconciliation accepts references, verifies the frozen expected effect and unlocks only untouched later steps. A revocation tombstone prevents new effects while allowing an already-started effect to be reconciled.

## Topic creation

The first adapter creates a standard discussion draft in an existing selected room. Other kinds, custom profiles, project/task recipes, invitations, room creation, automatic acceptance, funding and program mutation are outside this adapter. They require clarification rather than silent conversion to a discussion.

The shared `@ixo/ixo-transaction/topic-create-plan` encoder uses `@ixo/topic-protocol` 1.0.0-rc.7. It freezes the canonical v4 body, resolved shape, explicit participants and roles, title, tags, temporal mode, owner identity, generated IDs, proposal marker and evaluation time. Only independently verified root/body event references are substituted into later transport envelopes. The canonical Portal repository compares these values before writing.

The journal contains `anchor`, `body`, `operation` and `snapshot` steps. Every step requires its own one-use permit and verified predecessors. Topic operations use the protocol's `m.reference` relation. Bounded history reads must include canonical operation relations and refuse incomplete or forked evidence. A successful receipt records the actual verified Matrix root, body, operation and state event IDs. It does not fabricate a transaction hash or assert that participants joined a room.

## Claim access

Access grants are chain authorizations, not Matrix membership changes. The supported topic must have a verified canonical v4 body, claim binding and explicit `worker` or `evaluator` role assignments. A worker may receive submit-claim access; an evaluator may receive evaluate-claim access. Other topic roles do not imply these permissions.

The adapter verifies authenticated topic history and pinned body integrity, then queries the configured chain for the entity/admin account, collection binding, actual CW721 NFT owner and current authorization. Unavailable, truncated, delegated or forked authority evidence requires clarification. The actual NFT owner signs the exact encoded `MsgGrantEntityAccountAuthz` messages. Same-collection constraints are replaced once, unrelated constraints are preserved, and absolute expiry, quotas, limits, evaluator deadlines and memo are frozen for review.

The `grant` step becomes successful or failed only after the configured chain confirms the matching chain ID, transaction hash, exact ordered messages and memo. An ambiguous response remains unknown and is never blindly resubmitted.

## Private review and receipts

The existing Portal route `/a/<opaque-proposal-id>` preserves login continuation and owner authentication. URLs contain no DID, CID, credentials or execution arguments. Opening a link or preview performs no action. Private proposal responses use `private, no-store`; versioned static renderer assets may use public Cloudflare caching.

Portal retains only minimal owner/proposal/digest-scoped event or hash references for recovery. Recovered references do not confer authority. Every subsequent read and operation still authenticates the owner and validates the immutable proposal.

Channel outcomes use typed v2 receipts. The gateway preserves the original sealed request, binding, run, session, proposal and digest checks before delivery. It renders the readable title and friendly URL. Runtime Matrix receipts likewise use the recorded conversation origin. Neither transport delivery nor local browser state proves action success.

## Release evidence

Local tests must cover canonical producer equality, changed identities and authority, exact grant constraints, concurrent claims and permits, restart recovery, revocation, unknown effects, forged references, bounded timeouts, delayed read reconciliation and v1 regressions. The gateway must prove restart delivery and duplicate suppression.

Local tests do not close the live release gate. Record the selected provider's real-call verification under ORA-511, exact published and deployed package revisions, encrypted Matrix creation, real owner mobile-wallet signing, WhatsApp-originated review, cross-device recovery, original-session receipts, failure recovery and cold/warm latency. Operator-reviewed screenshots and recordings are required before activation. IXO-5609 and IXO-5618 stay open until these gates pass.
