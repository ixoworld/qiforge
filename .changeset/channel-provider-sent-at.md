---
'@ixo/oracle-runtime-workers': minor
---

Channel turns can carry the provider's send time of the person's message
(`providerSentAt`, epoch ms) and every turn result lists the new feature
`provider_sent_at`, so the channel gateway sends it only to runtimes that take
it. A value more than 5 minutes ahead or more than 48 hours old is ignored, not
refused; it is refused with a notice or an event. Plugins read it as
`ctx.session.channel.providerSentAt` and on the turn's human message as
`additional_kwargs.channel_provider_sent_at`, which the checkpoint save keeps.
An oracle can then tell a message sent before its last reply went out (two
messages in a row) from an answer to that reply.

`getRoomStateEvent` and `sendStateEvent` now join a room they are refused in as
not joined and try again for up to 5 s, as `getRoomState` already did. A new
user's delegation deposit (`POST /delegation`) failed with 500 when the bot had
not yet joined the user's fresh room, which happens while the bot restarts
(mainnet, 14 Nov 2026: 12 of about 1,024 deposits). A state call that still
fails logs the homeserver's message.
