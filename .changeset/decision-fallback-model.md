---
'@ixo/common': patch
---

The OpenRouter decision adapter asks `microsoft/microsoft-decision-1` once with the same request when the Jev request fails (no answer, a non-2xx status or an unreadable answer). An abort is never retried. `fallbackModel: null` turns it off.
