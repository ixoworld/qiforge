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
carries it with a notice or an event. Plugins read it as
`ctx.session.channel.entryPoint` (type `ChannelEntryPoint`, exported from the
package); it is stored with the run, so a resumed run reads the same. It is
untrusted advertiser text: the runtime never puts it on the model's input, the
message's `additional_kwargs`, the oracle room, trace metadata or a log, and
the click id (`ctwaClid`) must not be logged.
