---
'@ixo/oracle-runtime-workers': patch
---

asks: a turn never waits for asks.world's tool list. With nothing cached yet, the plugin answers at once with its own asks tools, tells the model the rest are loading, and fetches the list in the background, so the full set is there from the next message. A sign-in that ended is still noticed in that background fetch. Hosts without `background` wait for the list as before.
