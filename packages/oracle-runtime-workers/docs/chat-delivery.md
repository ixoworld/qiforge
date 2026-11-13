# Chat delivery

Portal turns stream Markdown into a rich view, unchanged. Turns that arrive from a chat app get a chat reply instead:

- turns from IXO Channels (`client: 'channel'`: WhatsApp now, Telegram and Slack later);
- turns from Matrix rooms (`client: 'matrix'`), which includes third-party oracles used from the Portal's rooms, when the chat style is turned on for rooms (`MATRIX_CHAT_DELIVERY=true` or `delivery.matrixChat: true`; off by default).

Scheduled task runs never get a chat reply, whichever room they report to: their result is stored and read later, so it keeps the model's whole text.

A chat reply is a few short messages, and an ordinary answer stays in them: many users read on WhatsApp alone, with no browser. Only document-length output, or a file the user asked for, becomes a document the user opens in a browser (an **artefact**), linked from the messages, and the messages still carry its conclusions, decisions and next actions. The design and its reasoning are in [`specs/chat-native-delivery.md`](../../../specs/chat-native-delivery.md). This page covers what the runtime does.

```mermaid
graph LR
    Turn[chat turn] --> Prompt[surface section in the prompt]
    Prompt --> Run[agent run]
    Run -->|finished| Plan[Reply Plan]
    Plan -->|plan in the poll response| Channels[IXO Channels gateway]
    Plan -->|one event per part| Matrix[Matrix room]
    Run -->|create_artifact or a long step| Art[(artefact: user DB + ciphertext in R2)]
    Run -->|send_file| File[(a sandbox file, by signed link)]
```

## Delivery profiles

`resolveDeliveryProfile` (`src/delivery/profile.ts`) picks a profile for each turn:

| Turn                                                       | Profile                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Portal HTTP                                                | `stream`: no surface section, no plan                                           |
| Scheduled task run (`taskRunId` set, or a `task:` session) | `stream`, on every surface                                                      |
| `POST /channels/turn`                                      | `chat` for `channel.provider` (`whatsapp`, `telegram`, `slack`), else `generic` |
| Matrix room (default)                                      | `stream`: the whole reply as one plain message, as before chat delivery         |
| Matrix room, direct, chat style on                         | `chat` `matrix`                                                                 |
| Matrix room, group, chat style on                          | `chat` `matrix`: 1–2 messages, 3 parts per reply, spill over 2,400 characters   |

The chat style for Matrix rooms is off unless `MATRIX_CHAT_DELIVERY=true` (per deployment, on the script that runs `UserOracleDO`) or `delivery.matrixChat: true` (in code). The variable wins when it is set, so `MATRIX_CHAT_DELIVERY=false` turns it off again for one deployment.

The limits are character counts, set well below each provider's hard limit. The gateways enforce the hard limits again:

| Limit            | Meaning                                                                         | generic, whatsapp | telegram | slack | matrix |
| ---------------- | ------------------------------------------------------------------------------- | ----------------- | -------- | ----- | ------ |
| `bubbleTarget`   | Preferred size of one message (the prompt asks for it)                          | 600               | 800      | 1,200 | 1,200  |
| `bubbleMax`      | Hard size of one message before a sentence split                                | 1,500             | 2,000    | 3,000 | 4,000  |
| `minBubble`      | Shorter fragments merge into the next message                                   | 60                | 60       | 60    | 60     |
| `maxBubbles`     | Preferred messages: the prompt asks for it, packing merges toward it            | 3                 | 3        | 3     | 3      |
| `maxPartsPerRun` | Parts in the whole reply, met by merging messages                               | 8                 | 8        | 8     | 8      |
| `spillChars`     | A step's rendered text longer than this becomes an artefact                     | 4,500             | 4,500    | 6,000 | 8,000  |
| `maxListItems`   | A longer list, or a table with more rows, becomes an artefact with a preview    | 15                | 15       | 15    | 15     |
| `previewItems`   | List items kept in the message that links to the artefact                       | 3                 | 3        | 3     | 3      |
| `maxCodeLines`   | A longer code block becomes an artefact                                         | 40                | 40       | 40    | 40     |
| `tables`         | Whether a table may stay inline as a table (otherwise one line per row in chat) | no                | no       | no    | no     |

A table never makes a step an artefact, and neither does the number of messages a step packs into. A Matrix group room gets `maxBubbles: 2`, `maxPartsPerRun: 3` and `spillChars: 2400`, so a group never hears a long answer in chat.

An oracle tunes delivery in its config:

```ts
createOracleWorker({
  config: {
    name: 'My Oracle',
    // …
    delivery: {
      // Matrix rooms reply in chat style too (off by default).
      matrixChat: true,
      // Per-surface overrides of the limits above.
      limits: { whatsapp: { maxBubbles: 2 } },
    },
  },
});
```

A count override must be a whole number of at least 1, and `tables` a boolean; any other value keeps the default. `bubbleTarget` and `minBubble` are held at or below `bubbleMax`.

Plugins see the profile as `ctx.session.surface`: `{ kind: 'stream' }` or `{ kind: 'chat', surface, label }`. A plugin can use it to return compact output on chat.

## The surface section

On a chat turn the prompt composer fills the `{{#SURFACE_BLOCK}}` slot, after the communication style, with a section rendered by `renderSurfaceSection` (`src/delivery/prompt.ts`). It tells the model where it is replying and how to write there:

- lead with the answer, because the user may have a chat-only data plan and no browser;
- prefer two or three messages (`maxBubbles` in words), and use more when the answer needs them rather than leave content out;
- keep ordinary answers in chat, comparisons, short plans and lists included; no headings or tables, and a small comparison as one line per item;
- use `create_artifact` only for a document or file the user asked for (with `send_file` bound: a document with no particular file format), or for genuinely document-length output, with the conclusions, decisions and next actions in its message;
- when `send_file` is bound, deliver every file meant for the user with it (one of the types it sends, named in the bullet; not helper scripts or intermediate files), build the file in the sandbox rather than send one downloaded from the internet unless the user asked for that exact file, never paste a download link, and keep `create_artifact` for a document with no particular file format; this bullet comes first. In a Matrix room it says a link is posted, not that an attachment arrives;
- don't narrate steps, because the user sees a typing indicator.

The section is empty on the Portal. When artefact storage is not configured, the section says instead that everything written is delivered, so a long answer should put the essential part first. The section, the `create_artifact` and `send_file` descriptions and the shaper state the same policy; change them together.

## Reply Plans

A chat turn's reply is a **Reply Plan**: an ordered list of parts.

```ts
type ReplyPlan = { v: 1; parts: ReplyPart[] };
type ReplyPart =
  | { partId: string; kind: 'text'; text: string }
  | { partId: string; kind: 'artifact'; artifact: ArtifactRef }
  | { partId: string; kind: 'file'; file: ReplyFile };
```

The plan is built once, when the run finishes, from the turn's AI messages (`src/delivery/plan.ts`). The checkpoint keeps what the model wrote; only the delivery changes.

1. **Narration is dropped.** Text of 200 characters or less written with a tool call ("Checking your calendar.") says nothing once the answer arrives, so it goes when a later step has text or a `create_artifact` call follows. When nothing follows it ("Your flight is 9:40, gate B12." with a `memory_save`), it is the answer and is kept. Longer text before a tool call is always content.
2. **`create_artifact` becomes three parts:** its message, the artefact, and its optional follow-up question. **`send_file` becomes one file part**, where the call stands in the turn; a call that failed adds nothing, and a file sent twice (the same stored path after the upstream normalised it) is delivered once, at its first place.
   A plugin tool's **standalone messages** (see [Standalone messages](#standalone-messages)) are kept aside and come last, after everything else in the reply.
3. **Every other step goes through the shaper** (`src/delivery/shaper.ts`):
   - It splits the text into messages on paragraph, line and sentence boundaries, and keeps each message under `bubbleMax`.
   - It turns headings into bold lines and keeps a lead-in ending in `:` together with the list that follows it.
   - It reduces raw HTML the lexer found (HTML elements and comments; `<br>` becomes a line break) to its text. Inline code and code blocks stay verbatim, and angle brackets that are not HTML elements (`Promise<string>`) stay.
   - It writes reference links (`[guide][1]`) inline, because their definitions are not delivered.
   - A part that is only whitespace or zero-width characters is never sent.
   - A table becomes one line per row (`- **first cell** · Header: value`), unless `tables` is set.
   - It groups short messages toward `maxBubbles`. A step already within `maxBubbles` keeps the model's message breaks. Otherwise its messages are filled left to right up to `bubbleTarget`, and if that still leaves too many, filled again from the start up to `bubbleMax`. In this step a code block of at least `minBubble` characters keeps its own message; a shorter one merges forward like any fragment. A step that cannot fit stays at more messages, never dropped and never spilled on count.
   - Only a document-length step is **spilled**: rendered text (blocks joined by blank lines) over `spillChars`, a code block over `maxCodeLines` lines, or a list or table over `maxListItems` items or rows. The full text becomes an artefact. In chat the step keeps a lead (its first paragraph or quote whole when it fits `bubbleMax`, cut at a sentence when not, or a list or table preview; a leading code block is skipped, since the artefact holds it, and a lone paragraph after it is the closing instead), the link, and a closing: its last block when the lead did not use it (a closing list or table previewed with its lead-in, or the last paragraph, with the one before it when both fit, or its last sentences that fit). A preview that must shrink keeps fewer items, then cuts one, and always keeps "…and N more". Lead and closing are what `capParts` drops first over the run cap; the artefact holds both.
   - No message, lead or closing is longer than `bubbleMax`. A heading or lead-in starts the message holding the block after it: when both would pass `bubbleMax`, that block is split with the room left. Only a lead-in over half of `bubbleMax` goes ahead as a message of its own, never joined onto the message before it.
4. **The plan is capped** at `maxPartsPerRun`. The shortest adjacent pair of text parts merges, as long as the result fits `bubbleMax`; a standalone message is never one of the pair. If that is not enough, a spill's lead and closing go, since its artefact holds both; the reply's last part stays as long as possible. Neither a file nor text found nowhere else is ever dropped, so a reply with several documents or files, or a long reply without artefact storage, can stay over the cap.
5. **A resumed run** puts back the text it had streamed before the reset, minus the steps the checkpoint kept, in front of the first step after them, or after the last step when the checkpoint kept every step. A resumed run with no step of its own delivers that text alone.

Part ids are `p1`…`pn`. The plan is stored in `turn_run_plans` with the run, and pruned with it after the seven-day run retention. A re-poll, a replayed Matrix event or a recovered run therefore gets the same plan and the same artefact links. If an artefact can't be stored, its step is sent as plain messages and the run still finishes.

The turn's `text` (the run record, `TurnResult.text`, the Matrix turn ledger's `reply_text`) is always the model's own text, on every surface; the plan sits next to it (`plan`, `reply_plan`). The plan rendered as one Markdown message, with artefacts and files as links (`planText`), is what a finished `/channels/turn` response carries as `text` for gateways that predate plans. `planTextForModel` names a file instead of linking it: the model reads it when a user quotes that reply, the Companion room mirror of a channel turn shows it (once per run, recorded in the channel receipt), and the transcript lists a reply of files alone with it.

## Standalone messages

A plugin tool can hand the reply text that must arrive **as a message of its own**: a dial code, a PIN, a reference number, something the person copies with one long-press. The shaper's grouping would otherwise join it to its neighbours: a fragment under `minBubble` (60 characters) merges into the message after it, a short code block included (only a code block of at least `minBubble` characters keeps its own message, and the run cap still merges any two text parts). Asking the model to copy the text verbatim also risks a paraphrase. A standalone message comes from the tool itself, and nothing about grouping changes for any other text.

````ts
import { tool, withStandaloneMessages } from '@ixo/oracle-runtime-workers';

tool(
  async (args, ctx) => {
    const voucher = await redeem(args);
    if (ctx.session.surface?.kind !== 'chat')
      // The Portal builds no Reply Plan: give the model the text instead.
      return { ready: true, dialCode: voucher.ussd, pin: voucher.pin };
    return withStandaloneMessages(ctx, {
      name: 'rewards_claim',
      // What the model reads. Say the messages follow the reply.
      content: {
        ready: true,
        hint: 'The dial code and the PIN go out after your reply, each on its own. Do not repeat them.',
      },
      // Each one delivered verbatim, alone, after the reply.
      messages: [
        '```\n' + voucher.ussd + '\n```',
        '```\n' + voucher.pin + '\n```',
      ],
    });
  },
  { name: 'rewards_claim', description: '…', schema },
);
````

- **API.** `withStandaloneMessages(ctx, { name, content, messages })` (exported from the package root and `src/plugin-api`) returns a `ToolMessage`: `content` (a string, or a value sent as JSON) is what the model reads; `messages` rides in `ToolMessage.artifact` under `standaloneMessages` (`STANDALONE_MESSAGES_KEY`). Like `send_file`'s link, the artifact never reaches the model provider; the checkpoint keeps it and the plan reads it back (`standaloneMessagesOf`). `messages` must hold 1 to `MAX_STANDALONE_MESSAGES` (4) non-blank strings of at most `MAX_STANDALONE_MESSAGE_CHARS` (1,024) characters; the helper throws a `TypeError` otherwise, and the plan ignores a list that breaks the limits.
- **Text.** Each message is chat Markdown, like a text part, delivered verbatim: the shaper does not touch it. On WhatsApp a fenced block (` ``` `) shows as monospace and keeps `*` characters as they are, so `*130*…#` is not read as bold.
- **Place.** After the whole reply: the model's text, cards, files and artefacts, then the run's standalone messages, in the order the calls stand in the turn (several messages of one call in their order). The model writes its introduction knowing the result, so "Dial the code in my next message" reads right.
- **Never merged.** The shaper never sees them, and the run cap never merges them with another part, so a reply can go over `maxPartsPerRun` by their count.
- **Bounded.** The same text handed over twice in a run (a tool called twice) is delivered once. A run delivers at most `MAX_STANDALONE_MESSAGES` (4) of them; any further ones are joined to the fourth with blank lines, so nothing is lost. A message longer than the surface's `bubbleMax` (only with an override below 1,024) is split like any text, each piece still alone. The model cannot produce them: only plugin code can, so a reply cannot explode into messages.
- **Surfaces.** Every chat surface delivers them alike (WhatsApp and the other IXO Channels providers, Matrix rooms with the chat style, group rooms included). A gateway that reads one message (`planText`) gets them after the reply, separated by blank lines. On the Portal, scheduled tasks and Matrix rooms in the plain style there is no plan, so they are **not delivered**: check `ctx.session.surface` and put the text in the result there, as above.
- **Durability.** A reset resumes with the checkpoint's `ToolMessage`, artifact included; a mid-turn summary that condenses the call away carries it in `turn_carry`, as for `send_file`. A run that fails after the call delivers files only (`failedRunFiles`), not standalone messages: the tool should let the person ask again (Yo Rewards: `rewards_pin`).
- **Secrets.** A standalone message is reply text: it is stored with the plan (`turn_run_plans`, `matrix_turns.reply_plan`), is in the `/channels/turn` response, and `planTextForModel` shows it to the model when a user quotes that reply, as when the model wrote it. The runtime never logs it (the delivery log line counts parts). Keep it out of `content`, so the model never holds it.

## Rich messages (buttons, lists, link buttons, cards)

On a channel turn whose gateway can show more than text (today WhatsApp through IXO Channels), every oracle gets up to three tools, with nothing to configure. The same reply reads as normal messages on Matrix, the Portal and any other client: every rich part carries its whole text version.

**Handshake.** Every turn result lists `rich_messages` in `features`. Once a gateway has seen it, it adds a `render` object to each message turn (and, once the runtime also lists `rich_events`, to each event turn, which is then handled exactly like a message turn here): the element kinds it can show for this binding (`reply_buttons`, `list`, `link_button`, `card`, `carousel`), the link-button label keys it can show, and the link origins its deployment approves. Only a turn that carried `render` gets the tools (only those its kinds allow) and a prompt section about them (`## Buttons in this chat`, after the oracle's own instructions, so it takes precedence over an instruction to write choices as a numbered list); without it (an older gateway, Matrix, the Portal, a task) nothing changes. `render` is stored with the run, so a resumed run renders the same way. The contract is in [channels](channels.md#rich-messages).

| Tool               | Offered when                                | What it sends                                                                                     |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `offer_choices`    | `reply_buttons` or `list`                   | A question with 2+ options: reply buttons, a list menu, or a numbered list. Ends the reply; once. |
| `send_link_button` | `link_button`, a label and an origin        | A message with one button that opens a link (optional header picture).                            |
| `send_cards`       | `card` or `carousel`, a label and an origin | 1 image card, or a carousel of 2–10, each with a picture, a short text and one link button.       |

**Format of `offer_choices`** (the runtime picks; nothing is ever cut, a set that does not fit moves on):

1. 2–3 options, every title at most 20 characters, no description, buttons available → reply buttons;
2. else at most 10 options, titles at most 24 and descriptions at most 72 characters, a list available → a list menu (menu label at most 20, default "Choose");
3. else → a numbered list in a normal message.

**Limits** (WhatsApp, Meta's guides, checked 2026-11-12): reply buttons at most 3, title 20; list at most 10 rows, row title 24, description 72, menu label 20; one link button, label from the fixed set; every body 1,024; carousel 2–10 cards, card text (`*title*\ntext`) at most 160 characters with at most 2 line breaks, one link button per card. The runtime checks them before emitting a part; the gateway checks again and sends the part's text instead on any breach or provider refusal. Neither side truncates.

**Link buttons.** The label is a key from a fixed set: `open` (Open), `allow` (Allow), `start_check` (Start check), `sign_in` (Sign in), `view` (View), `register` (View & register), `continue` (Continue); the gateway shows its own text for it. A link becomes a button only when its origin is in the turn's `render.linkOrigins` (the gateway deployment's list) and its label in `render.linkLabels`; anything else goes out as text with the link. A link (button, card or image) is parsed once: the raw string may hold no backslash, whitespace, control or format character, it must be https without user or password, the origin check runs on the parsed URL (lower-case ASCII host, so a look-alike or trailing-dot host never matches) and only the parsed `href` is sent (`safeHttpsUrl`); a text version shows the parsed `href` without user or password, and no link at all for any other scheme (`displayLink`). Images are public https links WhatsApp fetches itself; nothing copies or checks them, so only links anyone can open show.

**Text versions** (what other surfaces, the room mirror, quotes, the turn's `text` and a gateway that cannot show the part use):

- choices: the question, a blank line, `1. Title — description` per option;
- link button: the text, `Image: <url>` when there is a picture, `Label: <url>`;
- cards: the intro, then per card `n. **Title**`, its text, `Image: <url>` (always) and `Label: <url>`.

**Place in the plan.** A tool's part stands where its call stands in the turn, a message of its own (never merged with text, never split); the text the model wrote before the call in the same step is kept (it is not narration). A link or cards that could not be shown go out as one text message in the same place. The tool result tells the model which format went out and holds the text version, so the thread's history reads the same on every surface. The reply ends with a rich message: once a rich-message tool or a plugin's `withRichParts` sent something, no further model step runs (`RichMessageEndMiddleware`), so no filler follows the buttons. A call is sent back to the model once per turn (nothing goes out) when only a title or description length keeps options from buttons or a list, or when the text repeats the link; the second call goes out as it is.

**Taps.** A tapped button or row arrives as a normal turn: `message` is the option's title, `choice: { id }` the tapped id (`oc:<offer>:<key>`; the gateway's own topic-picker ids never carry `oc:`). The id counts only when this session offered it in the last 24 hours (`channel_choice_offers`, written when the plan is built); the model then reads a short note naming the question and the option (`channel_choice_note`, stripped from the person's words like the other notes). Anything else, and typed text, is just text.

**From plugin code.** A plugin with fixed sentences attaches the same parts without the model. Build the part against the turn's capability and return it with `withRichParts`; when the builder returns none, keep today's text:

```ts
import {
  linkButtonPart,
  renderOf,
  tool,
  withRichParts,
} from '@ixo/oracle-runtime-workers';

const message = `This lets me send you a link for your identity check. Please tap this to allow: ${url}`;
const built = linkButtonPart(
  {
    body: 'This lets me send you a link for your identity check.',
    url,
    label: 'allow',
    fallback: message,
  },
  renderOf(ctx),
);
// No button here (no `render`, a site not approved): today's sentence.
if (!built.part) return { status: 'sent', message };
return withRichParts(ctx, {
  name: 'my_tool',
  content: {
    status: 'sent',
    hint: 'The link was sent as a button after your reply; do not repeat it.',
  },
  parts: [built.part],
});
```

`choicesPart` and `cardsPart` work the same way. A plugin's rich parts come after the model's reply and its standalone messages. The credentials plugin uses this for its permission card (`allow`) and the identity-check link (`start_check`).

## Files

A file the oracle made in the sandbox reaches the user as an attachment through **`send_file`** (`src/plugins/sandbox/send-file.ts`). `create_artifact` remains for Markdown documents.

- **Binding.** The sandbox plugin binds it on chat turns only, and only when the upstream tools include `artifact_get_presigned_url`. On those turns the model cannot hold a link: `artifact_get_presigned_url` is not offered, and `artifact_get_by_path`, `artifact_list` and `artifact_get_by_cid` return their results without URL fields (a field whose name ends in `url`, and any string value that is a link), with a note in their descriptions. A result that is not JSON is replaced by an error, because links can only be removed from a structured result. The Portal, scheduled tasks and Matrix rooms in the plain style are not chat turns and keep the upstream tools unchanged.
- **Input and result.** `{ path, caption? }`: `path` is the stored path, such as `/output/report.docx` (the upstream aliases under `/workspace/` work too), and `caption` is at most 1,024 characters. The tool signs the file server side with the upstream default lifetime of 3 hours.
- **The link never reaches the model.** A signed link is a bearer credential, and a model that holds one pastes it. The model reads the `ToolMessage` content (`ok`, `filename`, `mimetype`, and a line that the file goes out with the reply, which promises nothing before the run ends). The `file` value of the part, link included, rides in `ToolMessage.artifact` with a runtime-only `path`; `@langchain/openai` does not send it to the provider and the Reply Plan reads it back. The link is never logged: failures are logged by kind only, and an upstream error is never repeated to the model, because it could quote a link.
- **Types.** `send_file` sends PDF, Word (`.docx`), Excel (`.xlsx`), PowerPoint (`.pptx`), text (`.txt`), CSV, Markdown (`.md`, `.markdown`), PNG and JPEG (`.jpg`, `.jpeg`), by the extension of the delivered name: the types the channel gateway delivers. Any other extension, the legacy `.doc`, `.xls` and `.ppt` included, fails the call before anything is signed, with an error naming the types and telling the model to convert the file or describe its contents. The tool description and the surface bullet name the same types (`SENDABLE_FILE_TYPES`), and tell the model to build the file in the sandbox, not send a file downloaded from the internet unless the user asked for that exact file. The gateway still checks the bytes (macros, embedded objects, external templates, active PDF content) and refuses a file that fails with a short text and no link; the runtime does not inspect content. Where a gateway delivers the file, the tool description and the surface bullet add `FILE_SAFETY_NOTE`: what the gateway blocks, so the model builds files without it, and to say it is sending the file rather than that it is attached, ready or delivered, and to fetch live data and write the values in rather than use a live-data formula (the Matrix room, which posts a link, and the Portal are unchanged); the tool's result says the same. A gateway that reads `features: ["delivery_notice"]` off the turn result can also send the refusal back as a notice turn, so the model fixes the file ([channels: delivery notices](channels.md#delivery-notices)).
- **Failure.** A missing file, a failed lookup, or a link a gateway would refuse (over 3,800 characters, or carrying credentials) returns `{ ok: false, error }` to the model, which can fix the path or tell the user. The run goes on: `send_file` is not return-direct, and it adds no part.
- **A run that fails after sending.** `send_file` always needs another model step, and a gateway reads a plan only off a `finished` run. A chat run that fails after sending files therefore ends as `finished`: the plan holds those files and a line saying the rest is missing, and its row keeps the error. Its text and cards are not delivered. The files come from the checkpoint, limited to this run's tool marks, so a run that failed before writing anything never repeats an earlier turn's file. An aborted run delivers nothing: the user stopped it.
- **Name and type.** `filename` is the path's last segment without control, format (bidi, zero-width) and filesystem-reserved characters, cut to 200 code points with its extension kept. `mimetype` comes from the extension (`pdf`, `docx`, `xlsx`, `pptx`, `txt`, `jpg`, `jpeg`, `png`, `md`, `markdown`, `csv`); there is no fallback type, because any other extension is refused. `bytes` is set only if the upstream reports a size; it does not today.
- **Durability.** `send_file` is `effect: 'read'`, so a call cut off by a reset runs again and gets a new signature. A finished call's `ToolMessage.artifact` is stored with the message in the checkpoint, so a resumed run still delivers it, and a mid-turn summary that condenses the call carries the file in its `turn_carry`. The stored plan keeps the link, so a re-poll after it expired returns a dead link.

```ts
interface ReplyFile {
  url: string; // https, signed
  filename: string;
  mimetype: string;
  bytes?: number;
  caption?: string; // at most 1,024 characters
  expiresAt?: string; // ISO 8601
}
```

The link sits in fewer places than an artefact link: the checkpoint (`ToolMessage.artifact`, and a summary's carry) and the stored plan (`turn_run_plans`, `matrix_turns.reply_plan`, and `text` in the `/channels/turn` response). The room mirror and the transcript hold the name. A LangSmith trace would hold `ToolMessage.artifact` too, so the tracer's client removes the signature of a signed storage link from every run's inputs and outputs (`redactSignedLinks`).

## Artefacts

### Creation

- **`create_artifact`** (`src/artifacts/tool.ts`) is bound only on chat turns, and only when storage and a public origin are configured. It takes `title`, `content` (Markdown, up to 200,000 characters), `message` (up to 1,000 characters: the conclusions, decisions and next actions, so the user has them without opening the document) and an optional `followUp`. Its description reserves it for a document or file the user asked for, or genuinely document-length output.
  - It is a **return-direct** tool: the run ends after a call that succeeded, with no second model call. A call that failed (arguments that fail its schema, a storage error) comes back to the model as an error `ToolMessage` and the run goes on, so the model can correct the call or answer in chat. A failed call with valid arguments still adds its message and question to the Reply Plan, before whatever the model writes next.
  - LangChain ends a step only when the step's _last_ tool call is return-direct. When the model calls it together with other tools, an `afterModel` hook (`src/core/middlewares/return-direct-first.ts`) moves it first, so the run continues and the model sees every result.
- **Spills** are artefacts the shaper creates from a document-length step.

Ids are deterministic: the first 128 bits of `sha256("artifact\0" + runId + "\0" + source)`. The source is the tool call id, or the step key for a spill. Creation is idempotent per id, so a recovered run gets the same document and the same link.

### Storage

| Copy      | Where                                      | Notes                                                                                                                 |
| --------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Canonical | `artifacts` table in the user's SQLite     | Exported with the rest of the working copy to the user's VFS file, so the user owns it.                               |
| Share     | R2 `art/<artifactId>` in `ARTIFACT_BUCKET` | AES-256-GCM ciphertext of `{v, title, mime, content, createdAt}`, 12-byte IV first. Custom metadata `expiresAt` only. |

The key is 256 random bits, generated in the user's Durable Object. R2 holds only ciphertext, and a viewer host (the built-in page's or a shared one) receives the key only in the fragment, which browsers do not send. The **operator holds the key**: it sits in plaintext in the user's database and so in everything derived from it:

- the `artifacts.share_key` column and the link in the run's stored plan (`turn_run_plans`), the Matrix turn ledger (`matrix_turns.reply_plan`) and the Matrix events posted to the room;
- the `create_artifact` tool result (a `ToolMessage` in the checkpoint), which is sent to the model provider on later turns of the session;
- the `/channels/turn` response, so the IXO Channels gateway and the chat provider (WhatsApp, …) see the link.

Anyone who can read the user's database, the model provider's request logs or the chat can open the document until its link expires or is revoked.

### Links and the viewer

```
https://<oracle>/a/<artifactId>#k=<key>                          built-in page
https://<viewer>#a=<encoded https://<oracle>/a/<artifactId>>&k=<key>   ARTIFACT_VIEWER_URL (Qi.Space)
```

- **`GET /a/:id`** serves one static page for every artefact (`src/artifacts/viewer-page.ts`). The page:
  - reads the key from the fragment and decrypts with WebCrypto;
  - renders the Markdown through DOM APIs only, with no `innerHTML`, only `http(s)` and `mailto` links, and images as links;
  - parses headings, the table divider row and inline Markdown in linear time, with a hand-written scanner instead of backtracking patterns, so a crafted line cannot freeze the reader's tab; a heading's closing `#`s are dropped only when a space sets them apart (`# C#` stays `C#`);
  - offers Copy and Download `.md`.
  - Its script is one static string (`VIEWER_SCRIPT`, no interpolation), so the bundled Worker serves exactly the text the CSP hash is computed from; `src/artifacts/viewer-page.test.ts` checks the hash and that the script holds no `__name(` helper a bundler could inject.
  - Its CSP allows only its own hashed script and style, and `connect-src 'self'`. The response also sets `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` and `nosniff`.
- **`GET /a/:id/data`** returns the ciphertext.
  - It answers any origin (`Access-Control-Allow-Origin: *`), so a shared viewer on another host can fetch it.
  - It is cached `private, max-age=60`, so a revocation takes effect within a minute.
  - It is rate-limited per client IP through `RATE_LIMIT` (key `<ORACLE_DID>|artifact|<ip>`).
  - An expired object answers `410` and is deleted.
- Both routes sit ahead of CORS and auth. Without the key they serve nothing readable.
- With **`ARTIFACT_VIEWER_URL`** set, links open a shared viewer instead: the Portal's `/artifact` page on Qi.Space.
  - It receives the source and the key in the fragment, so its server learns neither.
  - It fetches only `/a/<id>` paths on allowlisted hosts, and its analytics and error reporting drop the fragment.
  - Without it, the built-in page works on its own.

Link unfurlers (WhatsApp, Telegram, Slack, Matrix URL previews) fetch the path, never the fragment. They get the generic page and nothing else.

### Expiry, revocation, deletion

- Links expire after `ARTIFACT_LINK_TTL_DAYS` (default 30). The data route refuses an expired object and deletes it. Copies nobody opens again are deleted by the cron sweep (`src/artifacts/sweep.ts`): every `ARTIFACT_SWEEP_INTERVAL_HOURS` (default 24) it lists `art/` with each object's `expiresAt` and deletes the expired ones, so the bucket needs no lifecycle rule. It runs on the script that binds `ARTIFACT_BUCKET` and needs a cron trigger there; see [configuration](configuration.md#chat-delivery-and-artefacts) and [operations](operations.md#artefact-sweep).
- `DELETE /artifacts/:id` (authenticated, the owner only) deletes the share copy. The canonical copy stays. `GET /artifacts/:id` returns the canonical copy, with `url` only while the link works.
- Deleting a session deletes its artefacts: the share copies first, then the rows. If the R2 delete fails, the rows stay, and the links still expire on schedule.
- Revoking or deleting a channel binding does **not** revoke the artefact links already sent through it. Revoke them one by one with `DELETE /artifacts/:id`, or delete the session.
- Owner reads, revocation and the session cleanup need only the bucket binding. Removing `ORACLE_PUBLIC_URL` stops new artefacts (and `GET /artifacts/:id` returns no `url`), but the stored ones stay readable, revocable and deleted with their session. Removing the `ARTIFACT_BUCKET` binding itself also stops the sweep: the R2 copies stay in the bucket until an operator's lifecycle rule (if any) removes them, and the links stop working at once, because nothing serves `/a/:id/data` without the binding.

### Link policy

A link is **a bearer link: anyone who has it can open the document until it expires** (30 days by default). This choice, and the recommendation to review it, is recorded in the [repository README](../../../README.md#artefact-link-policy).

## Delivery by surface

- **IXO Channels.** A finished `/channels/turn` response carries `plan` next to `text` ([channels](channels.md#reply-plans)). The gateway renders each part in provider syntax, paces the parts, and delivers each one exactly once, keyed by `(userDid, bindingId, requestId, partId)`. It sends a `file` part as an attachment. A gateway that cannot read a part drops the whole plan and sends `text`, where a file is a link line.
- **Matrix rooms, chat style on.** The gateway posts one `m.text` event per part in the thread (`src/matrix/reply-parts.ts`). A text part's `formatted_body` is its Markdown rendered to HTML with any raw HTML from the model escaped, never passed through; a link or image whose URL is not `http(s)`, `mailto` or `mxc` renders as its text (an image as its escaped alt text). Room replays of HTTP turns use the same renderer (`renderRoomMarkdown`). An artefact is its title and an "Open document" link. A file is its name, its caption and an "Open file" link, which works until the link expires: a room has no gateway to fetch it into an attachment. Each part has its own transaction id (`reply-<eventId>-<partId>`), so a replay posts nothing twice. The typing indicator shows liveness while the run works.
- **Matrix rooms, chat style off (the default).** One plain `m.text` with the reply text and no `formatted_body`, byte for byte what the runtime sent before chat delivery.
- **Portal.** Unchanged: SSE frames, no plan.

## Tests

All in `pnpm test` (workerd), listed with what they prove in
[testing](testing.md#unit-tests-seconds): the plan, profile and shaper
(`src/delivery/*.test.ts`), the Matrix reply parts, the return-direct
ordering hook, the artefact store, sweep and routes, and the channel turn
that returns a finished run as its Reply Plan (`src/channels/turns.test.ts`).
`send_file` and the chat-surface tool filtering are in `pnpm test:core`
(`src/plugins/sandbox/send-file.test.ts`, `sandbox.plugin.test.ts`,
`src/core/main-agent.test.ts`), which the workerd suite excludes.
