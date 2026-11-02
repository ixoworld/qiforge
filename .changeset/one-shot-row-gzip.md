---
'@ixo/oracle-runtime-workers': patch
---

Long threads use far less of the user object's memory. The checkpointer gzipped and gunzipped every message row through its own `CompressionStream` / `DecompressionStream` on every checkpoint read and write, and each stream holds its zlib state outside the JS heap until it is garbage collected, so a turn on a few hundred messages held tens of MiB of zlib state (a devnet test oracle reset at about 120k tokens). Rows are now gzipped with node:zlib's one-shot `gzipSync` / `gunzipSync` (the same gzip format, so existing files read back unchanged). Measured on a deployed oracle: a turn on a 200-message thread kept 50 MiB of headroom instead of 6 MiB.
