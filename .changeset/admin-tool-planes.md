---
'@ixo/oracle-runtime': minor
'@ixo/oracle-runtime-workers': minor
---

Split agent-facing tools into an `orchestration` plane (the default) and an `admin` plane (`tool(handler, { …, plane: 'admin' })`).

Workers runtime: an admin tool requires `admin-tool/invoke` on `ixo:qiforge:admin-tool/<pluginName>/<toolName>` (`adminToolCapability`), checked by the same matcher as `manifest.requires`: a grant on `ixo:qiforge:admin-tool/<pluginName>` covers that plugin's admin tools, `ixo:qiforge:admin-tool` all of them, `*` everything, and an expired delegation grants nothing. Admin tools the turn's delegation does not grant are hidden entirely — never bound (main agent and sub-agents, including `forwardTools`), never in the Tier-1 prompt or a manifest example, never in `load_capability`'s tool list; a plugin left with no usable tool is not listed by `list_capabilities` (not even as unavailable), is refused by `load_capability` like an unknown name, and is not offered to the capability router. The capability gate refuses a call naming a withheld tool, and `wrapPluginTool` re-checks the capability right before the handler. The delegation checked is the one the user issued to the oracle (on a Matrix turn, the stored one), so an admin grant records the user's consent for their own turns, not operator authority: a user can issue it to themselves.

Node runtime (deprecated): admin tools require `invoke` on `ixo:qiforge:admin-tool:<toolName>`.
