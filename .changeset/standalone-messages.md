---
'@ixo/oracle-runtime-workers': minor
---

Standalone messages: a plugin tool can hand the chat reply text that must arrive as a message of its own (a dial code, a PIN), without changing the default grouping of any other reply.

- New `withStandaloneMessages(ctx, { name, content, messages })` (package root and `plugin-api`): returns a `ToolMessage` whose `content` is what the model reads and whose `artifact` carries `messages` under `standaloneMessages` (`STANDALONE_MESSAGES_KEY`); `standaloneMessagesOf(artifact)` reads it back. 1 to `MAX_STANDALONE_MESSAGES` (4) non-blank strings of at most `MAX_STANDALONE_MESSAGE_CHARS` (1,024) characters; the helper throws a `TypeError` otherwise.
- The Reply Plan delivers them verbatim after the whole reply, in call order, each as its own text part: the shaper never sees them and the run cap (`maxPartsPerRun`) never merges them. The same text twice in a run is delivered once; past four, the rest are joined to the fourth; a message over `bubbleMax` is split like any text. Every chat surface (IXO Channels, Matrix rooms in the chat style) delivers them alike; the Portal and other stream surfaces have no plan and do not deliver them (check `ctx.session.surface`).
- They survive a reset (the checkpoint keeps the artifact) and a mid-turn summary (`turn_carry` carries the call, as for `send_file`). The model never receives them, so a secret stays out of its context.
- Replies with no standalone messages are unchanged: same shaper, same profile limits, same plan. The Reply Plan wire format is unchanged, so gateways need no update.
