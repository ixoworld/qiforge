---
'@ixo/oracle-runtime-workers': minor
---

Long threads no longer reset the user object's isolate in a loop.

- **Context limits are bounded by the isolate, not the model.** Every threshold is now derived from the budget window: the model's window, at most `CONTEXT_MEMORY_WINDOW_TOKENS` (new, default 100,000). On a 1,050,000-token model the history is summarized at 60,000 tokens (was 630,000), old tool results are pruned above 35,000 (was 367,500), one tool result is capped at 48,000 chars (was 200,000) and a request above 87,000 is refused (was 989,500); the summarizer reads at most 83,000. Models with a window up to 100k keep their thresholds. The `[context]` line adds `budgetWindow=`, and `GET /debug/context` adds `window.budgetTokens`.
- **A thread already past that size is condensed on its next turn** by one summary that reads its newest 83,000 tokens, never the whole thread a second time; the oldest part of a longer thread is dropped unread (the transcript keeps it). Portal, Matrix and channel turns share this: the transcript is unchanged, the model works from the summary sooner.
- **A run is recovered at most 8 times in all** (`RUN_RECOVERY_TOTAL_ATTEMPTS`, new; counted by the row's `generation`). Progress still resets the consecutive no-progress counter, but a turn that checkpoints once and resets the isolate again is no longer resumed until its client gives up: it ends `interrupted`, and the channel gateway, the Matrix room and the Portal stream each get their failure notice.
- **LangSmith holds at most 8 MiB in memory** (`maxIngestMemoryBytes`; the library default is 1 GB) and drops runs past it. `redactSignedLinks` walks a run's payload and serializes it only when a signed link can be in it.
