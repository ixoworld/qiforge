---
'@ixo/oracle-runtime-workers': patch
---

Matrix room turns no longer run out of Cloudflare's loop budget ("Subrequest depth limit exceeded"). A Durable Object's outgoing calls are charged to its newest incoming request, so the gateway and a user object calling each other spent about four hops per room turn until a user chatting in a room had their model, memory and gateway calls refused. Work the gateway hands to a user object (a room turn, closing the status card, a group summary) now starts from an alarm invocation of the user object, which carries the full budget; a gateway call that is still refused is retried once from a fresh invocation, and a turn that fails on the limit logs a `[loop-limit]` warning (the gateway's failure log now includes the reason).
