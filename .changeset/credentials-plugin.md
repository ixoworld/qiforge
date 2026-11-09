---
'@ixo/oracle-runtime-workers': minor
---

A bundled `credentials` plugin: credential checks and the Auth Hub's two permission cards, WhatsApp only, off unless `CREDENTIALS_ENABLED=true` and `AUTH_HUB_CHANNEL_SERVICE_KEY` are set.

- Six tools for any credential type and fields, against the issuers the operator trusts (`CREDENTIALS_TRUSTED_ISSUERS`, default Self's IdentityLevel1 issuer of the network; the model may only narrow it), plus the Hub's catalogued actions: `credentials_request_check_permission`, `credentials_permission_status`, `credentials_check`, `credentials_request_action_permission`, `credentials_request_action` and `credentials_action_status` (`self.identity-check` links from Self).
- `credentials_check` makes the oracle an OpenID4VP verifier with `@ixo/credentials-kit` 0.1.1: its catalog entry, a signed request at the Credentials worker, the encrypted answer at `POST /credentials/response/:token`, verified in the person's object; `pending` with the wallet link when no standing consent answers in 20 s.
- `ctx.ucan.createInvocationFromDelegation` and `ctx.ucan.mintSelfSignedInvocation` take `facts` (put before the nonce, for services that bind a token to one request); `mintSelfSignedInvocation` takes a DID audience; `ctx.ucan.signWithOracleKey` signs bytes with the oracle's own key.
- Plugin inboxes (`src/core/plugin-inbox.ts`): a public callback appends to a row the user's plugin state opened, through the user object's `deliverPluginInbox`.
