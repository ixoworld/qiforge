---
'@ixo/oracle-runtime-workers': minor
---

An oracle on a chat surface now delivers a file it made as an attachment instead of pasting a signed download link.

- New `send_file` tool (`{ path, caption? }`), bound only on chat surfaces and only when the sandbox can sign links. It signs the stored file through the sandbox's `artifact_get_presigned_url` and returns a new Reply Plan part, `{ partId, kind: 'file', file: { url, filename, mimetype, bytes?, caption?, expiresAt? } }`, in the place of the call. It is `effect: 'read'`: a resumed run may run it again.
- The model never receives the link: it travels in `ToolMessage.artifact`, which the checkpoint keeps and no provider is sent. A quote of the reply, the room mirror and the transcript name the file instead, and traces lose the signature of any signed storage link.
- A file sent twice in one reply, even under another path alias, is delivered once. A link over 3,800 characters or with credentials fails the call, with an error for the model.
- On chat surfaces `artifact_get_presigned_url` is not offered, and URL fields are removed from `artifact_get_by_path`, `artifact_list` and `artifact_get_by_cid` results before the model sees them. The Portal and every non-chat surface keep the upstream tools unchanged.
- `capParts` never drops a file part, and several files stay in order. A file already sent survives a reset and a mid-turn summary. A chat run that fails after sending files ends as `finished`, with those files and a line saying the rest is missing; its row keeps the error.
- A gateway that cannot read a `file` part drops the plan and sends `text`, which carries the file as a Markdown link line with its caption. Matrix rooms post the file as its name and an "Open file" link, valid until the link expires, and the prompt says so instead of promising an attachment.
- `renderSurfaceSection` takes a third, required argument, `files`: whether `send_file` is bound this turn.
- A turn's steps now start at the turn's real opening message, so a human message the runtime writes itself (`view_attachment`) no longer cuts earlier steps out of the Reply Plan.
