---
'@ixo/oracle-runtime-workers': patch
---

An unverified IBC balance stays named by its full `ibc/…` denom: its denom trace is returned beside it as `trace: { baseDenom, claimedChain, path }`, which the tool tells the model is self-reported by the sending chain, and `origin` is set only for tokens verified by the IBC table. A light client can claim any chain id, so a trace must never make an arbitrary token read as, say, USDC from Noble.
