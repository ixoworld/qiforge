---
'@ixo/oracles-client-sdk': minor
---

`useAgAction` takes `exposeToAgent` (default `true`). An action registered with `exposeToAgent: false` is answered over the socket like any other but is not sent with the turn's `agActions`, so the model never sees or calls it — the oracle reaches it only from one of its own tools (the Portal wallet-signing action of `@ixo/ixo-transaction/react`). The context adds `registeredAgActions` (every registered action); `agActions` keeps only the ones offered to the agent.
