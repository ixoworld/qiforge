# @ixo/sqlite-saver

## 1.3.1

### Patch Changes

- [#318](https://github.com/ixoworld/qiforge/pull/318) [`9bb456a`](https://github.com/ixoworld/qiforge/commit/9bb456a87f161d4fd787f91b16ea6cda13226a1c) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Dependency updates. The LangGraph stack moves to `@langchain/langgraph` 1.4.17, `@langchain/langgraph-checkpoint` 1.1.5, `@langchain/langgraph-checkpoint-sqlite` 1.0.4, `@langchain/langgraph-checkpoint-validation` 1.1.1 and `@langchain/mcp-adapters` 1.1.4. Both SQLite checkpoint savers now accept the `counters_since_delta_snapshot` metadata key that `langgraph-checkpoint` 1.1.5 adds for delta channels. Also updates `@tavily/core` 0.7.12, `mammoth` 1.12.3, `@digitalbazaar/http-client` 4.4.0, `@changesets/changelog-github` ^0.7.0, and lockfile-only bumps for `jose`, `@ixo/matrix-crdt`, `@nestjs/swagger` and `vitest`.

## 1.2.0

### Minor Changes

- New databases are created with `auto_vacuum=INCREMENTAL`, and checkpoint pruning now runs `incremental_vacuum` so freed pages return to the filesystem instead of leaving the DB file at its high-water mark. Existing `auto_vacuum=NONE` databases are untouched here (no VACUUM in the request path) — the oracle-runtime sync service compacts them once, out of band.

## 1.0.4

### Patch Changes

- [`c643779`](https://github.com/ixoworld/companion/commit/c6437794acd28c833074763449502daf61e40a4c) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - matrix fix

## 1.0.3

### Patch Changes

- [`b5799ee`](https://github.com/ixoworld/companion/commit/b5799ee19a0957ad38e2374ae18e11278295a1ab) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Fix testnet signed mnemonics

## 1.0.2

### Patch Changes

- [#84](https://github.com/ixoworld/companion/pull/84) [`3117e8d`](https://github.com/ixoworld/companion/commit/3117e8d2f753811511de4eda8e99b18c3888e083) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - update

## 1.0.1

### Patch Changes

- [#79](https://github.com/ixoworld/companion/pull/79) [`0fe4fab`](https://github.com/ixoworld/companion/commit/0fe4fabaea19e081cec76e740c2e935a92eae338) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Add Gzip -- optmizeDB by removing unused indexes -- make token limit deduct more in devnet for easy tesing
