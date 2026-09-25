---
'@ixo/oracle-runtime-workers': minor
---

Chat-native delivery for IXO Channels and Matrix rooms.

- **Chat replies.** Chat turns get a prompt section that tells the model where it is replying. A finished chat turn becomes a Reply Plan: short messages in order, and artefact links for anything long. The plan is stored with the run, returned as `plan` on finished `/channels/turn` responses, and posted to Matrix rooms as one event per part. `text` stays the whole reply for older gateways. Portal turns are unchanged.
- **Artefacts.** A `create_artifact` tool (return-direct, chat turns only) and automatic spill of long steps. Documents are stored in the user's database and as AES-256-GCM ciphertext in R2 (`ARTIFACT_BUCKET`), with the key in the link's fragment.
- **Viewer.** A built-in viewer at `/a/:id`, or a shared one through `ARTIFACT_VIEWER_URL`.
- **Links** expire after `ARTIFACT_LINK_TTL_DAYS` (30 by default). The owner reads an artefact with `GET /artifacts/:id` and revokes its link with `DELETE /artifacts/:id`. Deleting a session deletes its artefacts.
- **Matrix rooms** use the chat style by default (`OracleConfig.delivery.matrixChat: false` opts out). Single-message room replies now carry `formattedBody`.
- `RuntimeContext.session.surface` tells plugins where a turn is replying.
