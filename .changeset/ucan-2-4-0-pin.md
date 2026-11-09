---
'@ixo/oracle-runtime-workers': patch
'@ixo/oracles-chain-client': patch
'@ixo/common': patch
'@ixo/oracles-client-sdk': patch
'@ixo/oracle-runtime': patch
---

Pick up `@ixo/ucan` 2.4.0, which refuses re-labelled UCANs. A UCAN archive's block CIDs are written by its sender and no signature covers them, so one signed invocation or delegation could be re-sent under another CID (a sha2-512 CID over the same bytes, its JWT form, a CBOR block with an empty nonce) and slip past a replay store or revocation check keyed on that CID. `validate()` and `validateDelegation()` now refuse with `INVALID_FORMAT` any archive whose UCANs do not sit under the CID derived from their signed form, and refuse JWT-form UCANs. The runtime's HTTP shell, the deposited-delegation check and the IXO Channels ingress all validate through the library, so they refuse such tokens too. These packages pinned `@ixo/ucan` 2.3.0 (directly, or through `@ixo/oracles-chain-client`); they now pin 2.4.0.
