---
'@ixo/oracle-runtime-workers': minor
---

Support binding-scoped quoted replies, idempotent channel cancellation and session controls, and memory refresh throughout continuous channel conversations. Preserve canonical quote metadata, prevent delayed cancelled requests from executing, and index finished channel turns incrementally.

Add opt-in, channel-only semantic conversation routing (`off`, `shadow`, `on`) with binding allowlists, durable assignments, owned quoted-thread resumption, and tool-free canonical clarification. Portal and Matrix retain explicit session selection.
