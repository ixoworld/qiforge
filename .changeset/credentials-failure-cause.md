---
'@ixo/oracle-runtime-workers': patch
---

Credentials: a failed identity check now says why when Self says so. Self's optional `failure` beside `status: "failed"` is read leniently (only `"error"` or `"too_many_attempts"` count; absent, any other value or type, or any other status keep today's words, never a parse error), kept in the short-term status cache, and answered with fixed words on `credentials_action_status` and the `identity_check_updated` event: `error` -> "Sorry, something went wrong with your identity check. Please ask me for a new link to try again."; `too_many_attempts` -> "Your identity check ran out of tries. Please ask me for a new link to try again."; absent -> "Sorry, your identity check didn't pass." `IDENTITY_FAILED_WORDING` and the `LinkFailure` type are exported.
