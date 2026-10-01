---
'@ixo/oracle-runtime-workers': minor
---

Chat-native delivery for IXO Channels and Matrix rooms.

- **Chat replies.** Chat turns get a prompt section that tells the model where it is replying. A finished chat turn becomes a Reply Plan: short messages in order, and artefact links for anything long. The plan is stored with the run, returned as `plan` on finished `/channels/turn` responses, and posted to Matrix rooms as one event per part. `TurnResult.text`, the run record and the Matrix ledger keep the model's own text; the plan is stored next to it. A finished `/channels/turn` response's `text` is the plan as one message, for older gateways. Portal turns and scheduled task runs are unchanged: a task run keeps the stream profile on every surface, so its stored result is the model's whole text.
- **Artefacts.** A `create_artifact` tool (return-direct, chat turns only) and automatic spill of long steps. Documents are stored in the user's database and as AES-256-GCM ciphertext in R2 (`ARTIFACT_BUCKET`), with the key in the link's fragment. R2 and the viewer host never see the key; the operator does (it is stored in the user's database, the stored plans, the Matrix ledger, the checkpointed tool result that is resent to the model provider, and the channel response).
- **Viewer.** A built-in viewer at `/a/:id`, or a shared one through `ARTIFACT_VIEWER_URL`.
- **Links** expire after `ARTIFACT_LINK_TTL_DAYS` (30 by default, 1 to 365; `ORACLE_PUBLIC_URL`, `ARTIFACT_VIEWER_URL` and the TTL are validated at boot). The owner reads an artefact with `GET /artifacts/:id` and revokes its link with `DELETE /artifacts/:id`. Deleting a session deletes its artefacts. Both keep working while the bucket is bound, also after `ORACLE_PUBLIC_URL` is removed. Revoking a channel binding does not revoke the links already sent through it.
- **Matrix rooms** keep one plain message per reply, exactly as before, unless `MATRIX_CHAT_DELIVERY=true` (or `OracleConfig.delivery.matrixChat: true`) turns the chat style on. With it on, raw HTML from the model is escaped in `formatted_body`.
- **Shaping**: raw HTML is reduced to text only where the Markdown lexer found HTML (never inside code, and `Promise<string>` stays); reference links are written inline; a short line with a tool call is dropped as narration only when the reply goes on after it; a part of only zero-width characters is not sent; a resumed run's leftover text lands after the last kept step, and a resumed run with no new step still delivers it.
- `RuntimeContext.session.surface` tells plugins where a turn is replying.
