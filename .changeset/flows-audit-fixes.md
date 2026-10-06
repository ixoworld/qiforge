---
'@ixo/oracle-runtime-workers': patch
---

Flows, AG-UI and Portal plugin hardening, and bounded document writes for the editor provider.

- `create_template` refuses a room that already holds a flow (`validation_failed`) instead of replacing it and its run state; change an existing flow with the edit tools.
- `add_step` keeps the flow's title, owner and step order, places the new step where asked, and refuses a step id that already exists without changing anything.
- A flow write the homeserver refuses now fails the tool with `needs_access`; a write that cannot be delivered fails with `error` after a bounded number of sends (honouring `retry_after_ms`) instead of being re-sent every 10 ms forever.
- A flow or editor document that fails to load now fails the tool within the retry budget instead of hanging; client errors and unreadable snapshots are not retried, and each load attempt has one overall deadline.
- Opening a document no longer waits a fixed 500 ms, and closing it aborts matrix-crdt's `/events` long-poll.
- `create_template` / `add_step` load the flow once for all post-compile passes (three loads per call instead of up to six).
- Authored flows have size limits (30 steps, 16 000 UTF-8 bytes of JSON per flow, 12 000 per step, 8 000 per step's inputs and per form pre-fill, plus caps on names, descriptions, conditions, skills and form questions); bytes, not characters, so CJK and emoji text cannot push a write past the homeserver's 64 KiB event limit. A too-large input is a `validation_failed` error naming the limit.
- Assigning a step is described as what it is — it authorises that DID to run the step — and the assignee must be a `did:` value.
- Secrets are never stored in a flow: inputs named like any action's secret port (`pin`, `mnemonic`, `matrixPassword`, `matrixAccessToken`, `matrixRecoveryPhrase`, `openRouterApiKeyPlaintext`, deploy `secrets`) accept only a `{{step.output.field}}` reference to a step of the same flow — a value merely wrapped in braces is refused — and form pre-fills refuse them outright. The PIN requirements and the operating guide say the portal collects these at run time.
- `{{ … }}` references are scanned in linear time (no regex backtracking on hostile document content), "{{a}} and {{b}}" is two references rather than one, and removing a step checks references nested inside maps and arrays.
- `remove_step` deletes the removed step's edges; `reorder_step` moves the step's block next to its neighbouring steps, so headings and notes no longer shift it out of place.
- `fill_form` refuses a form that is running, completed or awaiting read-back.
- `set_step_conditions` and `validate_flow` reject a condition on a step the flow does not have.
- `list_actions` applies its `category` filter (the action name's namespace) and reports each action's category; the three DAO governance proposal actions have catalogue entries, and conditionally required inputs are no longer marked always required.
- Browser tools and AG-UI actions declared in a request are validated per request: invalid or duplicate names and oversized descriptions or schemas are dropped, and at most 64 are kept.
- A flows write the homeserver did not acknowledge (server errors, a network failure, or the flush wait running out) now returns the `write_not_saved` code with a message that the change may or may not have been saved and the flow must be re-read before retrying, so the runtime keeps the write's claim instead of letting an identical retry duplicate it. A write refused with a client error (413, 400, 401) is still a plain `error`, and a forbidden write is still `needs_access`.
- Disposing a document after a flush has already timed out no longer waits for the flush a second time.
- `update_step` and `add_step` validate every part of a change before writing any of it, so a refused change no longer leaves half of it (or the new step) in the flow.
- Opening a document skips `POST /join` when the same Matrix client joined that room in the last 60 seconds, so a burst of tool calls shares one join. A write refused with `M_FORBIDDEN` forgets the room so the next load joins again, and a load refused because the oracle lost its membership joins again and retries once. An oracle removed from a room therefore gets a clear "room not accessible" error within a minute instead of the history up to its removal.
- Disposing a document while it is loading ends the retry back-off and the availability wait at once.
- Dropped AG-UI / Portal tool declarations are logged as one summary line per request.
