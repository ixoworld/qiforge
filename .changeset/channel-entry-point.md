---
'@ixo/oracle-runtime-workers': minor
---

Channel turns can carry the ad the person tapped to reach the chat
(`entryPoint`: Meta's Click-to-WhatsApp `referral`, every field mapped to
camelCase) and every turn result lists the new feature `entry_point`, so the
channel gateway sends it only to runtimes that take it. The runtime checks it
against the strict `ChannelEntryPoint` schema with the gateway's caps (ad id
digits, `https:` links of at most 2,048 characters, text caps in code points,
no control or bidi characters) and refuses a turn that breaks them, or that
carries it with a notice or an event.

Plugins read it as `ctx.session.channel.entryPoint` (type `ChannelEntryPoint`,
exported from the package) on turns where the agent is built, and at request
admission (`RequestAdmissionContext.session.channel`, now with the turn's
binding), so a handler that answers the turn itself can still record it. A
routing clarification, or a run cancelled or refused before either, never
shows it to a plugin, and the gateway sends an ad only once. The gateway may
attach an ad tapped before the person linked to a later message, so the ad's
time is `entryPoint.sentAt`, not the turn's. Hooks run again on a resumed
attempt: record it idempotently.

It is stored with the run in the user's working database (exported to the
owner store like all conversation data) and never put on the model's input,
the message's `additional_kwargs`, the oracle room, trace metadata or a log.
It is untrusted advertiser text, invisible format characters included, and the
click id (`ctwaClid`) must not be logged.

Action and topic receipts now keep only the channel fields their replay into
the oracle room reads (provider, binding, binding revision, message ref)
instead of the whole turn channel.
