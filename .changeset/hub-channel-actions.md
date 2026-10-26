---
'@ixo/oracle-runtime-workers': minor
---

Add an opt-in Auth Hub action plugin for authenticated channel turns. It binds
requests to runtime-owned channel identity, projects typed review references into
Reply Plans, and recovers typed outcomes on the originating run.
Channel polls answer Hub outcomes from SQLite and refresh at most one
non-terminal action per poll with backoff; prepares are capped per run, hour
and day and only allowed in runs a user message started.
