---
'@ixo/oracles-chain-client': patch
---

`fetchLinkedResourceDoc` sends the Matrix access token only for `/_matrix/client/v1/media/download/` on the caller's own homeserver, and follows no redirect with it. Any other `serviceEndpoint`, which an oracle's owner writes on chain, is fetched with no credential. `matrixHomeServer` may now be a URL as well as a bare host.
