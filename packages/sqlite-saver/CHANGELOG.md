# @ixo/sqlite-saver

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
