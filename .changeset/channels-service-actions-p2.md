---
'@ixo/oracle-runtime-workers': minor
'@ixo/ixo-transaction': patch
---

Add `hub_action_options` (service-tagged v2 discovery of the owner's
connections and targets) and prepare Gmail connect, disconnect and one
plain-text email send, plus signed-statement, Calendar, document-access-request
and private-text operations, from verified channel turns. Derive the tool
schema from action-protocol 0.4.0 (declaring protocol version 2 to Auth Hub;
`ixo.auth-outcome/2` with terminal `expired` / `cancelled`) and retain the original-turn outcome and
owner review boundaries. Only one Gmail send per mailbox is in flight at a time
(authorized, submitted or unconfirmed), and a Gmail operation must name one of the
owner's listed connections.

Pin the Worker-compatible Topic validator candidate in both consumers. Release
requires the reviewed action-protocol and Topic Protocol registry artifacts;
the committed source archives support local and CI validation only.
