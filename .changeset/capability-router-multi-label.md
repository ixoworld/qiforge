---
'@ixo/common': minor
'@ixo/oracle-runtime-workers': minor
---

The capability router preloads every plugin a message needs, and a preload is now a normal load on the thread. It asks one yes/no question per candidate over the message and the thread's latest turns, describes plugins by `summary` plus `whenToUse`, uses a one-second budget, and logs the top scores of every evaluated turn. The message's recent turns, as the user sees them in the transcript, now go to the Decision provider. The tool list changes once and stays until a cold turn unloads the plugin. It runs inside the build, so it is offered exactly what `load_capability` could load this turn, `always` plugins with `onDemandTools` included. A turn the provider's cache still holds asks for a higher score (`CAPABILITY_ROUTER_WARM_THRESHOLD`, default 0.8), since a wrong preload there costs a full cache miss; a cold turn asks for 0.7 (`CAPABILITY_ROUTER_COLD_THRESHOLD`). `manifest.routable: false` keeps a plugin away from the router; `memory` and `editor` set it.
