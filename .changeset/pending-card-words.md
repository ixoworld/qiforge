---
'@ixo/oracle-runtime-workers': patch
---

When Auth Hub cannot prepare a card because another card is still waiting for the owner's review (409 `sequence_reserved`), the model is told to say "You already have another card waiting for your review. Approve or decline that one first, then I can prepare this." and never to mention sequences; a sequence race (409 `sequence_mismatch`) is described by its effect instead of its code.
