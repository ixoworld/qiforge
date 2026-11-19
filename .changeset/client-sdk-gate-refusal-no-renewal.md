---
'@ixo/oracles-client-sdk': minor
---

A turn refused by one of the oracle's plugin gates is no longer mistaken for a credential refusal. The Workers runtime marks such an answer with `refused: true` in its error body (e.g. `402 insufficient_credits`, `503 credits_check_unavailable`, or a `403` with a plugin's own code such as `billing_account_unsupported`). Before, every `403` other than `VFS_AUTH_FAILED` renewed the credentials twice (a fresh invocation, then a fresh delegation, which may ask the user for their PIN) and sent the message again before the error surfaced. Now an answer with `refused: true`, whatever its status, is surfaced at once with nothing renewed: the send fails with a `RequestError` carrying `status`, `code`, `message`, `details`, `requestId` and `refused: true`, and `authedRequest` throws the same. `RequestError` gains the typed fields `refused` and `details`. A `401`/`403` without the marker is renewed as before.
