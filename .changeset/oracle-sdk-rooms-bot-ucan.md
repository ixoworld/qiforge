---
'@ixo/oracles-client-sdk': minor
---

`MatrixClient` sends the access token to the session's homeserver instead of the one the user's DID names, and `getOracleRoomIdWithDid` does the same (the room alias still comes from the DID). The hooks pass `wallet.matrix.homeServer`; a direct `new MatrixClient()` without `homeserverUrl` keeps resolving from the DID.

`createAndJoinOracleRoomWithDid` sends the rooms bot a UCAN instead of the access token. Hosts pass the new `getRoomsBotAuth` prop on `OraclesProvider`; `contractOracle` throws without it.
