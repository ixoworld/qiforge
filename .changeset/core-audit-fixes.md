---
'@ixo/oracle-runtime-workers': patch
---

Turn-building hardening in the runtime core:

- The summarizer reads no more history than its own model's window allows (`contextBudgetFor` takes the summarizing model's window). A failed summary is not attempted again in the same turn, and its token reservation is given back to the turn budget.
- A summary written in the middle of a turn records the turn's earlier tool calls, so an identical write after it is still refused and an earlier failure is still remembered.
- The system prompt shows the date and timezone only (`**Current date:**`), so it stays byte-identical across the turns of a day and the provider's prompt cache reaches past it. `renderTurnTimeNote` renders the exact time for the turn's own message; `formatDateContext` is exported.
- `load_capability` lists the tools the current turn collected; the shared tool and sub-agent registries no longer keep request-time tools from any turn.
- The "GPT-5.4 Nano" catalogue entry now has the id `openai/gpt-5.4-nano` and runs that model. Catalogue ids are unique and exactly one model is the default (GPT-5.6 Luna, unchanged).
- The OpenRouter `/models` fetch times out after 3 seconds, is shared by concurrent callers, serves an expired listing while it refreshes in the background, and waits 60 seconds after a failure before trying again.
- Sub-agents get the same identical-call caps as the main agent, and each dispatch's tool marks are kept apart, so two dispatches whose models reuse a call id both run.
- A plugin refused for unmet `requires` no longer shows manifest examples that name withheld tools.
- The capability router does not offer plugins whose `requires` the delegation does not grant, and computes hidden plugins only when it actually evaluates.
- Page titles in the page-context block are rendered as quoted single-line text and looked up once per room per turn.
- Per-message token estimates are memoised, so a long history is not re-serialised on every model step. The estimates are unchanged.
- The turn budget ignores non-finite token estimates instead of corrupting its counter.
- Plugins can declare an `operatingGuide` (a plain string on the plugin, outside the manifest). `load_capability` returns it, once per turn, when it loads the plugin or the capability router preloaded it, and the system prompt carries it under `## Capabilities in use`, after every other section and in plugin-name order, on turns that start with the plugin loaded on the thread or `always` visible (a one-turn router preload never enters the prompt, so the prompt cache survives it), and only when the user's delegation can use the plugin. Turns that do not use the plugin pay nothing for it. Boot logs each guide's size and warns above `OPERATING_GUIDE_WARN_TOKENS` (3,000).
- The flows plugin's operating guide (`FLOWS_OPERATING_GUIDE`) now reaches the model; before, nothing delivered it.
- Summarizing starts no later than the summarizer's own input limit (the history is condensed at the smaller of half the main window and what the summarizing model can read), so the summarizer never silently drops the oldest history or the earlier summary. With a 400k main model and a 131k summarizer this moves the trigger from 200k to about 112k tokens.
- A shared `/models` fetch that never settles is abandoned after its timeout plus one second, and every caller waiting on it is released by its own timer. `listModels(env, { waitUntil })` accepts the request's `waitUntil` for the background refresh.
- Tool-schema sizes in the context guard are kept across turns per schema object, name and description.
