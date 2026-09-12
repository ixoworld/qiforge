---
'@ixo/oracles-client-sdk': patch
---

Preserve SSE event state across network chunks, including UTF-8 and terminal frames, and report a connection closing without a completion event instead of implying success. Never resubmit a potentially mutating turn automatically.
