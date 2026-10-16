# Gmail connector

`GmailConnectorPlugin` is an opt-in Workers plugin. It checks a selected Gmail
account and reads its profile through the IXO connector proxy. It is absent
from `BUNDLED_WORKERS_PLUGINS`.

## Register the plugin

```ts
import {
  createOracleWorker,
  GmailConnectorPlugin,
} from '@ixo/oracle-runtime-workers';

export const worker = createOracleWorker({
  config: { name: 'My oracle' },
  plugins: [new GmailConnectorPlugin()],
  features: { 'gmail-connectors': true },
});
```

Keep the deployment's other required plugins in its `plugins` array. A feature
toggle of `false` disables Gmail. Automatic detection requires both connector
URLs. Explicit enablement with missing configuration fails boot.

| Configuration               | Meaning                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GMAIL_CONNECTOR_URL`       | IXO proxy base URL, without a query, fragment or URL credentials.                                        |
| `GMAIL_CONNECTOR_OWNER_URL` | Fixed Portal owner entry, such as `https://portal.example/settings/agents/gmail`.                        |
| `ORACLE_DID`                | Deployment account DID, also used by `WorkersUcanService` to sign. No entity or model-provided fallback. |
| `NETWORK`                   | Runtime network header, `mainnet`, `testnet` or `devnet`.                                                |
| `BLOCKSYNC_GRAPHQL_URL`     | Existing runtime resolver endpoint for verifying an owner's `did:ixo` signature.                         |
| `ORACLE_SIGNING_MNEMONIC`   | Existing runtime signing secret. The plugin reads only the signing helper.                               |

Connector URLs require HTTPS. HTTP loopback is accepted for controlled local
tests. The plugin needs no Composio API key or Composio SDK client. Keep broad
Composio access disabled when deploying this profile-only connector.

## Tools and results

The `gmail-connectors` capability loads on demand. Every tool accepts exactly
`{}` and has `effect: 'read'`.

| Tool                      | Behavior                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `gmail_connection_status` | Checks current proxy readiness and verifies the returned owner grant.                    |
| `connect_gmail`           | Returns a configured Portal owner-action link. It does not start OAuth or grant consent. |
| `read_gmail_profile`      | Rechecks readiness and reads the selected account's fixed `GMAIL_GET_PROFILE` operation. |
| `disconnect_gmail`        | Returns a Portal owner-action link. It does not revoke or disconnect an account.         |

Connection results use `status: 'authorization_required'`, `'pending'`, `'ready'`
or `'unavailable'`. Authorization-required and pending results contain a link
derived from `GMAIL_CONNECTOR_OWNER_URL`. The client never forwards a link
supplied by the proxy. A ready status contains only `connectedAccountId`,
`expiresAt` in Unix seconds, and `permission: 'gmail.profile.read'`.

Profile success returns `status: 'ready'` and `profile` with `emailAddress`,
`messagesTotal`, `threadsTotal`, and an optional numeric-string `historyId`.
Unknown fields are removed. No message bodies, arbitrary tool slugs, arguments,
model-selected accounts, batch execution, or writes are supported.

Connect and disconnect return `status: 'owner_action_required'`, `action`, and
`ownerActionUrl`. The link carries the deployment account `oracleDid`, the
authenticated `ownerDid` hint and the action. Portal verifies the owner and
registered oracle before consent. Returning a link is not evidence that the
owner completed the action.

An unavailable result has one of these safe reasons. Error bodies, minting
errors and delegation CARs are never returned to the model or logged by this
plugin.

| Reason            | Meaning                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `configuration`   | Required deployment configuration is invalid or absent.                                     |
| `signing`         | The oracle has no signing key or could not mint the request.                                |
| `connector`       | HTTP, deadline, response-size, parsing, signature resolution, or proxy availability failed. |
| `invalid_grant`   | A parsed owner grant fails the exact identity, scope, window or signature check.            |
| `invalid_request` | Tool arguments are nonempty or the authenticated owner DID is unsupported.                  |

## Signed proxy protocol

The only outbound connector operations are POST requests to
`/v1/agent-connectors/gmail/status` and `/v1/agent-connectors/gmail/profile`.
Headers are `authorization: Bearer <CAR>`, `x-auth-type: ucan`,
`x-ixo-network: <NETWORK>` and JSON content type. Redirects are returned
unfollowed and rejected. Each request has a 10-second headers-and-body deadline
and a 64-KiB response limit. There is one HTTP attempt and no automatic retry.

Status sends `{ ownerDid }`, with the owner taken only from `ctx.user.did`.
Its oracle-issued self-signed invocation has no proofs, a maximum 60-second
expiry, `connector/status` on
`composio://agent/<ORACLE_DID>/toolkit/gmail`, and signed `nb.requestHash`.

Internal ready status is `{ status: 'ready', connectedAccountId, delegation,
expiresAt }`. Before minting a profile read, the client verifies that CAR's
signature against the exact owner, direct owner-to-oracle issuer and audience,
zero parent proofs, one exact `tool/execute` capability, no capability caveats,
and finite expiry matching the status response. Expiry must be in the future
and no more than seven days away. Its resource is
`composio://toolkit/gmail/account/<connectedAccountId>/tool/GMAIL_GET_PROFILE`.
The raw proof remains a local variable during the call. The plugin never
caches it or writes it to `ctx.kv`, the blob store, messages or checkpoints.

Profile sends `{ ownerDid, connectedAccountId }`. Its invocation uses that
exact owner proof and account resource, `tool/execute`, signed `nb.requestHash`,
and a maximum 60-second expiry capped by the owner's grant. Existing minting
helpers add a fresh random fact to every invocation, so identical same-second
requests have distinct CIDs.

The request hash is lower-case hex SHA-256 over UTF-8 JSON of
`['ixo.agent-gmail.request.v1', action, ownerDid, oracleDid, connectedAccountIdOrNull]`.
Status uses `null` for the account. The proxy compares this signed hash with
the strict request and rechecks its current active grant and upstream account
before admission. The proxy's connector-local grant registry is the revocation
authority. A client-side valid signature alone is not current admission.

## Verification boundaries

`src/plugins/gmail-connectors/gmail-connectors.plugin.test.ts` runs against a
controlled HTTP server with real signatures and real runtime minting. It covers
exact binding, fresh invocation CIDs, readiness, rejected grants, fixed input,
owner links, sanitized failures, size bounds, redirects, cancellation and the
client deadline.

`test/gmail-connectors.test.ts` runs the plugin through the real capability gate
and LangGraph turn inside workerd. It uses synthetic signers and a controlled
HTTP transport, verifies both invocation signatures, and inspects the final
checkpoint for proof leakage. `src/do/ucan-service.test.ts` covers caveat
forwarding and compatibility with existing self-signed callers.

These tests do not establish live OAuth, current Composio tool schemas or
versions, readonly provider scopes, deployed D1 revocation behavior, or live
WhatsApp continuity. Activation requires a configured dedicated readonly Gmail
auth config, verified provider metadata, owner consent, and operator release
authorization. No deployment or migration is part of this package change.
