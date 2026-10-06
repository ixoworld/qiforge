---
'@ixo/oracle-runtime-workers': patch
---

Tasks and attachments hardening.

- Approving a `before-action` task no longer runs the task inside the `resolve_task_approval` tool call, where the run's own write tools waited on the write slot the approval call was holding until the turn timed out. The approval is stored with the task and the next alarm, armed for right away, runs it once, including after a reset. The tool now says the run is starting rather than that it has finished.
- Task specs are parsed and rendered without gray-matter's module-wide content cache, which grew with every task save for the life of the isolate.
- The run history keeps the newest 50 rows per task (plus any still open). A closed ordinary run no longer keeps its result text; Topic deliverables keep theirs. A new partial index serves the next-delivery-round query, so it no longer scans the history.
- While a task's turn is being recovered after a reset, the alarm no longer re-arms every second; the end of the recovered run re-arms it.
- The minimum interval between cron runs is checked over every pair of consecutive fire times, including across midnight, weekday and month-end boundaries and the task timezone's DST changes in the coming year. Irregular patterns such as `0,30-34 * * * *` are now refused.
- An alarm tick runs up to 3 due tasks at a time instead of one after another, so one slow task no longer holds back the others. No task runs twice.
- An approval request is retried across a gateway restart under a transaction id fixed per occurrence, so neither a lost send response nor a reset right after the send makes the user see the request twice or fails the task.
- A delivered run's history row records that run's own output, not the previous run's.
- A one-shot task whose result could not be delivered says so, without asking the user to run it again. A Topic deliverable posts no room notice for it and stays readable through its API.
- An idle alarm tick issues 4 SQL statements, and `onAlarm` returns the next wake it computed so the host does not need to query it again.
- Attachments share one 50 MB download budget across the native and extraction lanes. A file's declared size is checked against what is left before it is downloaded, and each download is cut off at what is left. A file over the budget or an empty file is noted instead of being downloaded a second time. Usage of paid extractions is always counted. A file whose bytes contradict its claimed type (a PDF named `.png`) is never sent to the model as a native block, in a turn or through `view_attachment`; it goes through extraction, which notes the mismatch. Container formats keep their claimed type: `.docx`/`.xlsx`/`.pptx` (zip), HEIC/AVIF (ISO-BMFF) and the like are sent natively as before, and HEIC/AVIF photos now also pass the extraction lane's content check.
- Matrix media downloads have the same 60 s deadline as http downloads and stop when the turn is aborted (`MatrixMediaSource` methods accept an optional `AbortSignal`, and `readBytesCapped` cancels the stream when it fires).
- A redirect without a `Location` header reports that error instead of "Too many redirects".
- `view_attachment` can cache extracted text per session, attachment and extraction model (`AttachmentTextCacheStore`), so repeated views skip the download and the helper-model call. Only Matrix media is cached (what an http(s) URL serves can change); entries expire after 30 days and a session keeps its newest 50. An unsupported file type is no longer downloaded just to report that it is unsupported.
- The tasks plugin drops a user's task surface when their turn ends, so it no longer keeps evicted user objects' schedulers reachable.
- The ChatGPT reachability probe at the start of a ChatGPT turn gives up after 5 s (counted as reachable), and a "check my key" call after 10 s, instead of waiting on a stalled provider.
- The task-approval hint recognises a plain "yes" or "no" again when the message carries the turn time note.
