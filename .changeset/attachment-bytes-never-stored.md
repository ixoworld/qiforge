---
'@ixo/oracle-runtime-workers': minor
---

Attachment bytes are no longer stored with the conversation. A file the model reads natively stays inline, as base64, only in the turn's in-memory state; the checkpointer stores every message that carries such blocks (the person's message and the `view_attachment` re-attachment) with one placeholder text in their place, listing each attachment with its reference, in message rows, checkpoint blobs and pending writes alike. The attachment metadata is kept, so transcripts are unchanged. Before, the bytes sat in the checkpoint and were replayed on every model call until a turn completed and the retention pass rewrote turns older than the newest two; a large file could reset the user's Durable Object mid-turn, before that pass ever ran. The retention pass is removed.

Images of the newest two user turns are put back into each model request at call time, from their source (Matrix media, channel links, http(s)), downscaled when the oracle binds `IMAGES`: at most 4 per request, each fetched once per run with a 15 s deadline; a failed fetch leaves the placeholder. Documents and older images come back through `view_attachment`. A durable run resumed mid-turn sees the placeholder for its own files and recalls its images the same way.
