---
'@ixo/oracle-runtime-workers': patch
---

Channels: Telegram turns. The quoted-reply note names the turn's channel (`[Telegram reply: …` for `telegram`, `[Chat reply: …` for a provider without a name of its own; WhatsApp's note is unchanged, byte for byte), and the credentials plugin's tools accept a `telegram` binding as well as a `whatsapp` one (`channelBinding`, `CARD_CHANNEL_PROVIDERS`; `whatsAppBinding` stays exported as the same function). The docs show a `CHANNEL_SERVICE_DID` listing two gateways, served by the oracle's one `AUTH_HUB_CHANNEL_SERVICE_KEY`.
