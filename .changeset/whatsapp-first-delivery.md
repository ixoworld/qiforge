---
'@ixo/oracle-runtime-workers': minor
---

Chat delivery is WhatsApp-first: an ordinary answer stays in the conversation instead of becoming a link, because many users read on a WhatsApp-only data plan with no browser. The surface prompt, the `create_artifact` description and the shaper now state the same policy.

- The shaper spills a step to an artefact only when it is document-length: rendered text (blocks joined by blank lines) over `spillChars`, a list or table with more than `maxListItems` items or rows, or a code block over `maxCodeLines` lines. A small table stays in chat as one line per row, and the number of messages a step packs into no longer spills it.
- **`maxBubbles` changed meaning.** It is no longer a spill trigger: a per-oracle `delivery.limits.<surface>.maxBubbles` override now sets how many messages the prompt asks for and the shaper groups toward (paragraphs filled left to right up to `bubbleTarget`, then up to `bubbleMax`; a code block of at least `minBubble` characters keeps its own message). An oracle that lowered it to send fewer messages before an artefact now gets fewer, fuller messages and no artefact.
- No message, spill lead or closing is longer than `bubbleMax`: a heading or "…:" lead-in that would pass it with the next block is sent on its own, and a short fragment merges forward only when the result fits.
- A spill keeps more in chat: its first block whole when it fits `bubbleMax` (a longer paragraph cut at a sentence; a list or table previewed), and after the link its closing list or table previewed, or its last paragraph (with the paragraph before it when both fit), whether or not it is a question.
- A header-only table renders as its header line, an empty first cell no longer renders as `- ****`, the hard split never cuts an emoji, and sentence splitting uses a pinned `en` locale.
- New defaults: `spillChars` 4,500 (Slack 6,000, Matrix 8,000), `maxListItems` 15, `maxCodeLines` 40, `maxPartsPerRun` 8, `maxBubbles` 3 on every surface (WhatsApp and Telegram were 4). Matrix group rooms get `maxBubbles: 2, maxPartsPerRun: 3, spillChars: 2400`. Per-oracle `delivery.limits` overrides work as before.
- The prompt asks for two or three messages (a blank line marks where a message may break; short paragraphs are grouped), more when the answer needs them, states the list and code sizes that stay in chat, keeps comparisons and short plans in chat, and reserves `create_artifact` for a document or file the user asked for or genuinely document-length output, with the conclusions, decisions and next actions in its message.
- `create_artifact`'s `message` now takes up to 1,000 characters (was 600) to hold those conclusions. It is delivered as its own text part before the link, never inside the link card.
