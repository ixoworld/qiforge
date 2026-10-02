# @ixo/oracle-runtime

## 1.99.0

### Minor Changes

- [#329](https://github.com/ixoworld/qiforge/pull/329) [`8efad56`](https://github.com/ixoworld/qiforge/commit/8efad567fc8dfdcf996d3b16cecadf9aa231bae5) Thanks [@ig-shaun](https://github.com/ig-shaun)! - Split agent-facing tools into an `orchestration` plane (the default) and an `admin` plane (`tool(handler, { …, plane: 'admin' })`).

  Workers runtime: an admin tool requires `admin-tool/invoke` on `ixo:qiforge:admin-tool/<pluginName>/<toolName>` (`adminToolCapability`), checked by the same matcher as `manifest.requires`: a grant on `ixo:qiforge:admin-tool/<pluginName>` covers that plugin's admin tools, `ixo:qiforge:admin-tool` all of them, `*` everything, and an expired delegation grants nothing. Admin tools the turn's delegation does not grant are hidden entirely — never bound (main agent and sub-agents, including `forwardTools`), never in the Tier-1 prompt or a manifest example, never in `load_capability`'s tool list; a plugin left with no usable tool is not listed by `list_capabilities` (not even as unavailable), is refused by `load_capability` like an unknown name, and is not offered to the capability router. The capability gate refuses a call naming a withheld tool, and `wrapPluginTool` re-checks the capability right before the handler. The delegation checked is the one the user issued to the oracle (on a Matrix turn, the stored one), so an admin grant records the user's consent for their own turns, not operator authority: a user can issue it to themselves.

  Node runtime (deprecated): admin tools require `invoke` on `ixo:qiforge:admin-tool:<toolName>`.

### Patch Changes

- [#330](https://github.com/ixoworld/qiforge/pull/330) [`92d478b`](https://github.com/ixoworld/qiforge/commit/92d478b8e23b6c9daa0e353e476689b99b81bb0d) Thanks [@Michael-Ixo](https://github.com/Michael-Ixo)! - DEPRECATED: the Node runtime is no longer developed. Use `@ixo/oracle-runtime-workers` (Cloudflare Workers). The package README, description and entry points now say so; nothing else changes.

- [#318](https://github.com/ixoworld/qiforge/pull/318) [`9bb456a`](https://github.com/ixoworld/qiforge/commit/9bb456a87f161d4fd787f91b16ea6cda13226a1c) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Dependency updates. The LangGraph stack moves to `@langchain/langgraph` 1.4.17, `@langchain/langgraph-checkpoint` 1.1.5, `@langchain/langgraph-checkpoint-sqlite` 1.0.4, `@langchain/langgraph-checkpoint-validation` 1.1.1 and `@langchain/mcp-adapters` 1.1.4. Both SQLite checkpoint savers now accept the `counters_since_delta_snapshot` metadata key that `langgraph-checkpoint` 1.1.5 adds for delta channels. Also updates `@tavily/core` 0.7.12, `mammoth` 1.12.3, `@digitalbazaar/http-client` 4.4.0, `@changesets/changelog-github` ^0.7.0, and lockfile-only bumps for `jose`, `@ixo/matrix-crdt`, `@nestjs/swagger` and `vitest`.

- [#328](https://github.com/ixoworld/qiforge/pull/328) [`dc0950a`](https://github.com/ixoworld/qiforge/commit/dc0950a28ba704af22fe3e127584845bba87b07d) Thanks [@ig-shaun](https://github.com/ig-shaun)! - Add provider-neutral PortableWorkDefinition and AgentWake contracts. Task adapters in both runtimes now expose reusable definition-only work and stable notify-only wake envelopes without carrying authority, approvals, credentials, or execution state. Portable definitions reject duplicate list entries and reserved authority, credential and execution-state keys in `configurationDefaults` (exported as `PORTABLE_WORK_RESERVED_CONFIGURATION_KEYS`, matching the Topic Protocol schema), and the Workers adapters validate their output with the schemas before returning it.

- Updated dependencies [[`9bb456a`](https://github.com/ixoworld/qiforge/commit/9bb456a87f161d4fd787f91b16ea6cda13226a1c), [`dc0950a`](https://github.com/ixoworld/qiforge/commit/dc0950a28ba704af22fe3e127584845bba87b07d), [`e40dc1c`](https://github.com/ixoworld/qiforge/commit/e40dc1cfa5efd5c099b424ee10f8c9a30eddbf50), [`3d8ad32`](https://github.com/ixoworld/qiforge/commit/3d8ad32de0a7040595f32298de442cd811bfc4ba)]:
  - @ixo/common@1.6.0
  - @ixo/matrix@1.2.34
  - @ixo/sqlite-saver@1.3.1
