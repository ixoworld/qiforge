---
'@ixo/oracle-runtime-workers': minor
---

Rich messages on channel event turns: an event turn (a permission card answered, an identity check updated) may now carry `render`, and its run gets exactly what a message turn with `render` gets: `offer_choices`, `send_link_button`, `send_cards`, plugin rich parts through `renderOf(ctx)` / `withRichParts` (the credentials plugin's Allow and Start check buttons), the same plan parts, and taps on choices it offers. Turn results list the new `rich_events` feature so a gateway can tell this runtime from 0.50.0, which refuses `render` with an event. `choice` stays refused on an event turn.
