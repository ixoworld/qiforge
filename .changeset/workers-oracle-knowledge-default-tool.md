---
'@ixo/oracle-runtime-workers': minor
---

The memory plugin's default tool selection now includes `memory-engine__add_oracle_knowledge`, so the controllers and owners of any oracle can grow its shared knowledge from chat ("save this as oracle knowledge") without a per-oracle code change. The Memory Engine, not the runtime, decides who may use it: a caller whose DID is not a `controller` or `owner` of an entity linked to the oracle DID is refused on chain, and the tool needs the user's explicit confirmation of the scope (`public`: every user of the oracle reads it; `private`: its controllers and owners only). OAuth callers of the engine never get the tool. A fork that wants the previous surface passes `selectedTools` without it. The plugin manifest tells the agent when to store oracle knowledge instead of a memory about the user.
