---
'@ixo/oracle-runtime-workers': minor
---

Rich WhatsApp messages for every oracle: `offer_choices` (reply buttons or a list menu), `send_link_button` and `send_cards` (an image card or a carousel), offered only on channel turns whose gateway sends a `render` object, with a channel-neutral text version on every other surface. Turn results list the new `rich_messages` feature; channel turns accept `render` and `choice` (a tapped option, checked against the choices offered in the session in the last 24 hours). New plan parts `choices`, `link_button` and `cards`. Plugin helpers `linkButtonPart`, `choicesPart`, `cardsPart`, `renderOf` and `withRichParts`; the credentials plugin sends its permission card and identity-check link as Allow and Start check buttons where the chat can show them. Links are parsed once and only their normalised href is sent.
