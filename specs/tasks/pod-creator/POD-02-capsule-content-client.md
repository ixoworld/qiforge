# POD‑02: Capsule content client

**Phase:** 1 — Foundation
**Spec:** §6, §12
**Effort:** 2 days
**Depends on:** POD‑01
**Blocks:** POD‑04
**Parallel with:** POD‑03

## Goal

A request‑time `CapsuleContentClient` that resolves a design‑pod role's capsule and returns its
`SKILL.md` text — UCAN‑authed, with per‑thread caching. This is the registry‑loaded prompt source
the specialist sub‑agents consume in POD‑04.

## Deliverables

### Created

- `packages/oracle-runtime/src/plugins/pod-creator/capsule-content-client.ts` —
  `get(capsuleRef, rt): Promise<string>`. Reuses the skills plugin's UCAN header builder
  (`Authorization: Bearer <ixo:skills invocation>`, `X-IXO-Network`) and `SKILLS_CAPSULES_BASE_URL`.
  Resolves the capsule's `SKILL.md` text (content endpoint or sandbox `load_skill` — confirm per
  §12.2). Validates the registry response with Zod at the network boundary.
- `packages/oracle-runtime/src/plugins/pod-creator/design-pod-roles.ts` — `DESIGN_POD_ROLES` map:
  role id → capsule name/cid + short description + the role's tool set (consumed by POD‑04).
- `packages/oracle-runtime/src/plugins/pod-creator/capsule-content-client.test.ts`.

## Acceptance

- [ ] Returns the `SKILL.md` text for a known role against a stubbed registry.
- [ ] Sends the UCAN invocation header when available; degrades to public‑only **without throwing** on auth failure.
- [ ] Per‑thread cache: a second request for the same role within a thread does not re‑fetch.
- [ ] Registry outage surfaces a clear error (no silent empty prompt); optional cached‑last‑good fallback.
- [ ] A malformed registry payload yields a clean Zod parse error, not a downstream type bug.

## Out of scope

- Wiring the client into `getRequestSubAgents` (POD‑04).
- Publishing capsules — already live in the registry (§12.1).

## Notes

- Mirror the `skills-tools.ts` fetch / validate / header patterns; do **not** duplicate the
  discovery tools (`list_skills` / `search_skills`).
- No `as`‑casts at the network boundary — parse, don't assert.
