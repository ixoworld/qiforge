---
'@ixo/oracle-runtime-workers': patch
---

Keep long threads from resetting the user object's 128 MB isolate on turns with tool calls: the main agent runs a message's tool calls in one tools node instead of one full-state graph task per call, LangSmith traces keep only the newest messages of a graph or middleware run's state (a model's prompt stays whole) and upload in batches of at most 4 MiB (no run is dropped), the checkpoint saver re-keys unchanged message rows without serializing them again, and the runtime's literals are Latin-1 so a minified bundle's source is stored at one byte per character.
