---
'@ixo/oracle-runtime-workers': minor
---

Much cheaper turns. The prompt and the first call shrink, and the prefix changes only when it has to, because any change to the tool list or the system message costs a full cache miss.

- **Selective discovery.** Every plugin with something to load is named in a one-line catalogue (`manifest.brief`), so reaching one takes one `load_capability`. `sandbox` and all of `vfs` are on-demand now; `manifest.onDemandTools` holds tools back inside an `always` plugin, and `memory`, `skills` and `user-preferences` use it. Hosts undo any of it with `manifestOverrides`.
- **The cold-turn rule.** Idle plugins (`CONTEXT_PLUGIN_IDLE_TURNS`), stale tool results (`CONTEXT_STALE_RESULT_TURNS`) and the operating guides in the system prompt only change on a new thread or after `CONTEXT_CACHE_COLD_MS` of quiet.
- **Operating guides and usage.** A plugin's usage and guide reach the model at the tail of the messages, in the load result or as a note on the turn's message, and a guide enters the system prompt on the next cold turn. The thread records what its messages carry, so a summary only costs a note. The sandbox's storage rules moved from its `summary` to a guide.
- **Cleaner memory.** The history indexer sends only the conversation: what the user said and the oracle's replies. Tool results, status lines before a tool call, extracted file text, JSON-shaped assistant text and the reply to a turn that read memory no longer become evidence.
- **Facts first in the memory block.** Past its cap the user-context block keeps every bucket's facts before entities, topic clusters and raw episodes, instead of cutting the text after the early buckets.
- **One copy of every MCP result.** A result sent with a structured copy of its text is sent once.
- **Domain context.** `detail: 'compact'` by default, with `pass1.excerptChars` for the excerpts.
- **Fixes.** `load_capability` no longer fails a whole batch on an unknown name; it refuses that name and loads the rest. `read_result` reads the newest result of a reused call id. `loadedPlugins` kept only the last value because `createAgent` ignored the reducer on `MainAgentGraphState`; the browser-tool section of the prompt changed when the portal capability loaded; `new AbortController()` at module scope stopped `wrangler dev` on workerd before 1.20260825.

`MainAgentArgs.preloadedPlugins` is replaced by `routeCapabilities`, `MainAgentBuildResult` gains `stateUpdate` and `guideNote`, and `CapabilityRouteTurn` takes `candidates`.
