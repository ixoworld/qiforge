---
'@ixo/oracle-runtime-workers': patch
---

A reply no longer says the same thing twice when the model writes a rich message's question as its text too. Text in the same step as `offer_choices`, `send_link_button` or `send_cards` that is all inside that message is dropped, and text that ends with the message's opening keeps only the sentences before it ("Hi there!" instead of "Hi there! What would you like to do?" above the question "What would you like to do?").
