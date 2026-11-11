---
'@ixo/oracle-runtime-workers': patch
---

credentials: no unasked identity proof check after a card is allowed, Self's "passed, proof being saved", and the Hub's refusal reasons.

- `already_verified` (`credentials_request_action`) now means: the person is verified, go on with the task you were doing; a next step an event note or another plugin gave comes first; call `credentials_check` only when this oracle itself needs to read a claim from the credential for its own decision and no next step was given (it used to say "use credentials_check instead", which made the model share `age_over_18` unasked after an allowed Yo Rewards card). The `passed` link status, the `already_allowed` hint, the operating guide and the identity-check event note follow the same rule.
- A permission or identity-check event note with another plugin's `next` / `verifiedNext` (from `rememberPermissionCard`) names it as the ONLY next step ("do exactly this next step ... and nothing before it ... do not add credentials_check or any other call it does not name"), and every agent event note says to use the tools already bound and call `load_capability` only for a missing one.
- Self's optional `saving: true` beside `status: "in_progress"` (approved, the proof not saved yet) is read leniently, kept in the 5 s status cache beside `review`, and answered on `credentials_action_status` and the `409 link_active` refusal with "You passed your identity check. Your proof is being saved; this can take a minute. Please ask me again shortly." Events are unchanged.
- The Hub's `reason` beside `400 unnamed_service` is read leniently and logged (`reason=<code>`); `oracle_not_linked` keeps the person's sentence and gives the operator hint that the oracle's entity must list the oracle's signing account as a linked entity with service `matrix` and relationship `admin`. `isSaving` and `hubReasonOf` are exported.
