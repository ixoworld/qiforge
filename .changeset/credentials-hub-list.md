---
'@ixo/oracle-runtime-workers': patch
---

credentials: the Auth Hub is the source of truth for a person's permissions and the kv only a cache. Before a card is sent, and when the kv holds no usable card or grant, the plugin reads the person's live cards from the Hub (`GET /api/internal/permissions?bindingId=…&bindingRevision=…`, at most once per tool call and 6 times a minute per person): an allowed card that covers the request is used again (`already_allowed`, grants restored), a waiting card is handed back instead of a second one, and a grant Self refuses is refreshed once. A Hub without the list (404/405), or one that is down, leaves the behaviour as it was.
