# CI

What runs where, gated by what, and what blocks merge.

## Per-PR jobs

These run on every PR. All must pass before merge:

| Job | Command | Notes |
| --- | --- | --- |
| Lint | `pnpm lint` | ESLint. Strict — no warnings allowed in changed files. |
| Format | `pnpm format:check` | Prettier. Strict. Run `pnpm format` to fix. |
| Build | `pnpm build` | Turbo-orchestrated tsc across packages. Catches typecheck errors. |
| Unit tests | `pnpm test` | Vitest. Runs every `*.test.ts` across packages. No `.env.integration` required. |

PRs that touch only docs (`docs/`, `*.md`, `*.mdx`) may skip the build job if configured — confirm in `.github/workflows/`.

## Integration job

Integration tests (`*.int.test.ts`) run on a separate job because they need:

- `.env.integration` secrets in the CI environment.
- A reachable Matrix homeserver.
- LLM credits.

The job is currently:

| Trigger | Behaviour |
| --- | --- |
| Push to main | Run all integration tests. |
| Manual workflow dispatch | Same — used for debugging. |
| Per-PR | Not by default — too expensive. |

If you want integration tests to gate a PR, add the label that triggers the workflow (or the equivalent — check the repo's workflow config).

## What gates merge

- All per-PR jobs green.
- One approving review.
- No merge conflicts with main.

Integration tests do NOT gate merge by default. If a PR breaks integration tests on main, the fix lands as a follow-up PR.

## What CI does NOT do

- **No automatic release.** Versioning + publishing is manual until the versioning policy lands.
- **No eval gates.** Layer 3 eval suites run separately and aren't tied to PR merges.
- **No spec re-validation.** The spec is design history; CI doesn't check it against shipped code.

## Local pre-commit checklist

Before pushing:

```sh
pnpm lint
pnpm format
pnpm build
pnpm test
```

If you touched integration test paths:

```sh
pnpm test:integration
```

(Requires `.env.integration`.)

## Secrets management

`.env.integration` and CI secrets are managed outside this repo. Don't commit either. The example shape is `apps/qiforge-example/.env.integration.example` — copy and fill locally.

If a new env var is needed for an integration test, also document it in the example file so other engineers can copy.

## Adding a new CI job

Patterns to follow:

- Mirror the existing jobs' Node version and pnpm version.
- Use the workspace's lockfile (`--frozen-lockfile`).
- If the job needs secrets, route them via the CI provider's secret store — never inline.

Discuss in a PR before adding — CI minutes are finite.

## Read next

- [Integration tests](integration-tests.md) — what runs in the integration job.
- [Test harness](test-harness.md) — the unit-test surface.
