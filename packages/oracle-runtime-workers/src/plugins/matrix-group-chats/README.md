# matrix-group-chats (Workers)

**Status: under development — off by default.** The port of the Node
runtime's `matrix-group-chats` plugin is complete and tested (unit, local
harness, devnet), but it has not been reviewed for production use and it
differs from Node in the ways listed below. Until that review, every
deployment runs with the gateway's `MATRIX_GROUP_ROOMS=silent` (the default):
the bot never speaks in a room with more than two members and captures
nothing there. It only talks in direct rooms — the user↔oracle room and the
task rooms it creates. Set `MATRIX_GROUP_ROOMS=gate` on the gateway to turn
the lane on for a deployment; `answer` replies to everything (Node without
the plugin).

How it works when enabled: [operations — Rooms: group chats](../../../docs/operations.md#rooms-group-chats).
Env knobs: [configuration](../../../docs/configuration.md#matrix).
Drills: `pnpm test:e2e:group` (gate) and `GROUP_ROOMS=silent pnpm test:e2e:group`
(the default) in `apps/qiforge-workers-example`; unit tests in
`src/matrix/group-chat.test.ts` and this directory.

## What is the Node contract, unchanged

- The gate and its order: a direct room always answers; in a group room the
  bot answers a message that mentions it (`m.mentions.user_ids`), a
  quote-reply to one of its own messages, or a message in a thread it
  answered within `GROUP_CHAT_ACTIVE_THREAD_TTL_MS` (30 min); otherwise it
  stays silent. An answer is skipped when the bot's power level is below the
  room's `m.room.message` threshold or `GROUP_CHAT_REQUIRE_POWER_LEVEL`.
- Every group message, answered or not, is captured into the room's channel
  memory; batches are compacted with the Node summarizer prompt, verbatim,
  into summary chunks (FTS5 search with the porter tokenizer, LIKE fallback,
  `OR` of the words, ranked), next to pinned facts and the member roster.
- The four tools with Node's names, descriptions and schemas:
  `recall_channel_memory`, `search_channel_memory`, `pin_room_fact`,
  `unpin_room_fact` — offered only to a session in a group room.
- A group message reaches the model as `[DisplayName]: …`; the bot's own
  user id in a message body becomes `(USER MENTIONED YOU @AI_AGENT)`; the
  message's `additional_kwargs` carry `senderDid`, `senderMatrixUserId`,
  `senderDisplayName`, `threadId`, `eventId`.
- Compaction at 20 buffered messages, and just in time before an answer when
  5 or more are buffered, capped at 3 s so the reply is not held up.
- The `delegation_required` prompt for a member without a delegation is
  posted into the room the message came from, as on Node.

## Where it differs from Node

| Area                                                                                                      | Node                                                                                                                                                                                                              | Workers                                                                                                                                                                    | Why                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the gate runs                                                                                       | An agent middleware inside the speaker's turn: every group message was dispatched as a turn (typing indicator, `work_status` card, the message appended to the speaker's thread history) and then ended silently. | The gateway decides before a turn exists: an ignored message shows no typing, posts no card, wakes no user object and is not appended to the speaker's thread history.     | Cheaper, and a member who cannot boot a user object never fails a turn for a message nobody would answer. Cross-person context came from channel memory on both runtimes.                            |
| Direct-room rule                                                                                          | `is_direct` on the create event, else ≤ 2 joined members.                                                                                                                                                         | The same two rules, plus: a room whose canonical alias is a user↔oracle alias of this oracle is direct whatever its member count.                                          | A real user↔oracle room also holds the rooms appservice bot and the memory-engine bot (four members on devnet); Node's rule alone would gate the oracle's own conversation with its user.            |
| Active threads after a restart                                                                            | Scanned the room's last 100 messages for the bot's own replies.                                                                                                                                                   | A durable `group_bot_threads` table written whenever the bot decides to answer; nothing is scanned.                                                                        | The gateway restarts far more often than a Node process; a table read is local and exact. Threads answered before this build are not in it — one mention re-activates them.                          |
| Where channel memory lives                                                                                | One SQLite file per room on the oracle's disk, gzipped and uploaded into the room as an encrypted media event (`qiforge.channel_memory.v1`) after every change, restored from there on a cold start.              | The gateway's Durable Object SQLite (`group_*` tables), which survives deploys on its own; nothing is uploaded to the room.                                                | No disk and no need for the room copy on Workers. A Node-era snapshot in a room is **not imported**; the tables use Node's column layout, so an importer is a small addition.                        |
| Who runs the summarizer                                                                                   | The oracle process, `session-title` model role.                                                                                                                                                                   | The speaker's user object (`summarizeGroupMessages` RPC), same model role and prompt.                                                                                      | The gateway script holds no model keys.                                                                                                                                                              |
| Compaction buffer                                                                                         | In memory; lost on restart.                                                                                                                                                                                       | Durable (`group_message_buffer`); a replayed message is not buffered twice.                                                                                                | Gateway resets are routine.                                                                                                                                                                          |
| Idle compaction                                                                                           | After 5 quiet minutes.                                                                                                                                                                                            | Not ported; the next engagement compacts the buffer (threshold and just-in-time triggers are unchanged).                                                                   | The gateway's alarm belongs to the bot SDK. A quiet room's summary exists by the first moment anyone could read it.                                                                                  |
| Tier rollups (weekly / monthly)                                                                           | Code present, never scheduled.                                                                                                                                                                                    | Not ported; `tier` stays 1.                                                                                                                                                | Dead on Node.                                                                                                                                                                                        |
| Prompt injection of roster, pinned facts, recent messages (`buildSessionContext`) and `getCurrentSpeaker` | Code present, never called.                                                                                                                                                                                       | Not ported.                                                                                                                                                                | Dead on Node.                                                                                                                                                                                        |
| Speaker prefix on file messages                                                                           | Strings only.                                                                                                                                                                                                     | Also the first text block of block content (a caption with an attachment).                                                                                                 | Workers' attachment pipeline produces block content.                                                                                                                                                 |
| Members without a delegation                                                                              | Answered (a turn needed no delegation; memory calls failed softly).                                                                                                                                               | On a VFS-backed deployment their user object cannot boot, so a mention from them ends in the "try again" notice.                                                           | The Workers owner-copy design: the user's history file lives in their VFS and needs their delegation. The Portal deposits one for whoever invites the oracle into a room, not for the other members. |
| Enabling                                                                                                  | On by default (`features: { 'matrix-group-chats': false }` to turn off).                                                                                                                                          | `MATRIX_GROUP_ROOMS` on the gateway: `silent` (default), `gate`, `answer`. Disabling the plugin only removes the tools; the gateway policy decides whether the bot speaks. | The gate is runtime infrastructure here, not a plugin middleware.                                                                                                                                    |

## Open items before this can be the default

- Review the divergences above with the product owner.
- Decide whether members without a delegation should be prompted in group
  rooms (the Portal's `delegation_required` listener is deliberately not
  mounted) or answered without a user file.
- Decide whether Node-era channel-memory snapshots need importing.
- Decide whether task rooms should be recognised by the gateway's own record
  of the rooms it created rather than by member count (a task room with a
  third member becomes a group room today).
