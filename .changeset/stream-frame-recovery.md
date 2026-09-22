---
'@ixo/oracles-client-sdk': patch
---

SSE parser follows the specification for framing: a frame's lines may arrive across any number of network reads (UTF-8 sequences included), `\r\n` line ends are accepted, several `data:` lines are joined, and a heartbeat comment never ends a frame in progress. Event ids, malformed-frame handling and abort behaviour are unchanged.
