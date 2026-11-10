---
'@ixo/oracle-runtime-workers': patch
---

credentials: the Auth Hub first, before any grant is used.

- `credentials_request_action` (the Self identity link) and `credentials_action_status` read the person's live cards from the Auth Hub (the list, once per tool call) before they use any grant, and only the Hub's answer decides. An allowed, current item with running grants: its grants are used and the kv's copy is refreshed from them. Anything else (stopped, ended, `current: false`, still waiting): the kv's card in use and its kept grants are dropped and no service is called; the answer is "not answered yet", "once more" (the card is sent again, as in 0.46.4), "ended" or "ask for permission".
- The kept grants are only a fallback for when the list cannot be read (the Hub down, slow, 429/5xx, an older Hub without the route, the per-person cap of 6 reads a minute): the tool then goes on from the kv as before, so a Hub outage never blocks the person, and logs `hub_unread (<reason code>)` as a warning.
