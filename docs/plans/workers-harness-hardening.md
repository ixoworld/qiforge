# Workers harness hardening

The implementation keeps Companion instance policy small and adds reusable controls in the Workers runtime. Node is outside scope.

1. Preserve the latest inbox/turn-ledger/reset-repair behavior; add uncertain tool-operation records, explicit read effects, bounded reads and child concurrency. Remove fabricated subagent authorization retries.
2. Share cumulative model reservations, tool attempts and deadlines across a turn. Store usage diagnostics in user SQLite; treat exhaustion as terminal.
3. Offload large results before they enter history. At the final model boundary, account for system text and exposed schemas, preserve call/result identity, and permit only one smaller overflow recovery request. Preserve history if summarization fails.
4. Correct client SSE chunk framing and incomplete-connection reporting; settle server action frames on abort. Never replay a potentially mutating POST as transport recovery.
5. Port the small prompt into Companion Workers, load Portal schemas on demand, test the composed prompt, and build both Worker scripts against the exact Qiforge change.

## Verification and delivery

Run core unit tests, the real workerd/SQLite suite, SDK parser tests, typechecks, lint and format checks. Record deployed/provider evaluation as a release gate, not a completed test. The release changesets prepare Workers minor and client SDK patch versions. Do not publish or deploy in this task. Companion uses an immutable Qiforge source pin for the review; replace it with the released npm version after the upstream release. No copied runtime patch or unpublished npm-version assertion is needed.

## Deliberate limits

Text token counts are conservative estimates, not billing enforcement. The configured context window must fit all selected provider lanes. Arbitrary plugin-owned external calls and downstream service retries remain service responsibilities. Fingerprints prevent identical uncertain writes, not semantically equivalent operations with changed arguments. Operator reconciliation remains necessary where a downstream service has no idempotency API. Client SDK publication/Portal consumption and deployed comparative model evaluations remain separate rollout steps.
