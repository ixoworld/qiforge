# Observe-only domain context

**Status:** implemented in `packages/oracle-runtime-workers` (Oct 2026), not yet released. Re-implements the domain-context part of an earlier unmerged change on top of [durable runs](durable-runs.md) and the [harness hardening](workers-harness-hardening.md); the Node runtime is out of scope.

## What it does

A turn can be given two `domain.md` documents as retrieved data: the
oracle's own domain (`ORACLE_ENTITY_DID`, constitutional guidance) and the
subject the client selected (`metadata.currentEntityDid`, task context). Each
is found through its IID's `#dom` linked resource on Blocksync, verified by
CID, linted with `@ixo/domain.md/workers` and checked against its own DID.
The model gets one `<verified_domain_context>` block after the system prompt
(sub-agents get it too) and two read tools, `read_domain_document` and
`refresh_domain_context`. Configuration is `createOracleWorker({ domainContext })`;
default off.

## Guarantees

1. **Observe only.** Nothing in a domain document grants a capability,
   changes authorization, adds a tool or activates a capsule. A missing,
   stale or invalid domain is reported, and the turn continues under the
   existing capability checks.
2. **Integrity, not authority.** Bytes must match the anchored CID and pass
   static validation. Blocksync is trusted as the read projection of the
   chain; no chain proof, live authority, time or revocation is checked, and
   every provenance entry says so (`assurance`).
3. **Precedence.** The block states that runtime instructions outside it take
   precedence and that its content is data, never instructions.
4. **Bounded cost.** One resolver per user object caches anchors (5 min TTL),
   verified public bytes and parsed indexes; a repeat turn inside the TTL
   makes no network call. Pass-1 reads run in parallel under one 3 s budget;
   a late read is reported as `pass1-timeout`, not waited for. The parsed
   indexes are bounded by count and by index text (4 Mi characters). The
   `@ixo/domain.md` validators are bundled but loaded on first use, so an
   oracle with domain context off does not evaluate them at isolate start.
   An index with over 64 KiB of frontmatter, a frontmatter list of more than
   64 items at any depth, or nesting deeper than 16 levels is refused
   (`index-too-large`) before the lint, whose cost grows about quadratically
   with the length of a malformed list; inside those bounds the measured
   worst case lints in about 0.2 s.
5. **One revision per run.** The anchors a run read are pinned on the run;
   a resumed attempt reads the same revisions. `refresh_domain_context`
   takes effect on the next turn.
6. **Private stays private.** Private bytes are never kept in the byte or
   text caches, and every read is authorized again (the user's VFS UCAN, or
   the host's `readPrivateDocument`); without a reader a private document is
   unavailable, never fetched publicly. The parsed private index (its raw text
   included) does stay in the in-memory parsed-index cache, keyed by CID, and
   is handed out again only after a fresh authorized read whose bytes verify
   against that CID.
7. **Diagnosable.** Provenance (DIDs, CIDs, status, findings, documents read)
   goes out on `router_update` and into `domain_context_runs`, deleted with the
   session; recording failures never fail the turn. Finding codes are
   deduplicated and capped at 32 entries per domain (a cut list ends in
   `findings-truncated`), so a hostile index cannot inflate the prompt, the
   stream or the stored row. The table is created by the first recorded turn;
   an oracle with domain context off never has it.

## Where it lives

- `src/core/domain-context/` — resolver, transport, prompt block and tools.
- `src/core/main-agent.ts` — loads it next to the request-time tool
  collection, appends the block, binds the tools, passes both to sub-agents.
- `src/do/user-oracle-do.ts` — the per-object resolver, pins on the stored
  run request, the `router_update` frame and the store
  (`src/do/domain-context-store.ts`).
- `src/do/turn-metadata.ts` — `currentEntityDid: null` clears the subject.

## Not covered

Publishing or anchoring constitutional documents, live-authority
conformance, capsule activation, and enforcement modes. Provider-dependent
behaviour (how models use the block) is a rollout check, not a test result.
