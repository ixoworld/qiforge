---
'@ixo/oracle-runtime-workers': minor
---

Channel turns can carry files. `POST /channels/turn` accepts an optional `attachments` list (at most 10): each a WhatsApp photo, video, document or audio file the gateway serves from an https capability link, with `filename`, `mimetype`, `size`, `sha256` and `kind`. The body stays strict otherwise, and `message` still carries the caption or a placeholder. The run gets them as ordinary attachments, so the model sees the image or the extracted text, and tools read the raw list as `ctx.session.channel.attachments` to keep the files (for example as claim evidence). A file that cannot be fetched becomes a note in the message; it does not fail the turn.

`@ixo/action-protocol` 0.7.0, Hub protocol level 5 on every Hub call (options still answer as level 3): `request_hub_action` can ask for the application card `ixo.bid.submit.v1` (send an application to a claim collection's bids bot as the person) and the claim card `ixo.claim.submit.v1` (upload the evidence, sign the answers, save the claim and submit it on chain as the person, in one approval), where the Auth Hub has enabled them for the oracle. Their receipts (`ixo.bid.submission.v1`, `ixo.claim.submission.v1`, `ixo.submission.failed.v1`) come back as outcomes. Chain-transaction cards (`ixo.chain.tx.v1`) are unchanged.
