# Skill contracts

Skill discovery describes a capsule. It does not establish whether the host can execute it. `list_skills` and `search_skills` return `execution: unchecked`.

Use `inspect_skill({ cid, path: 'SKILL.md' })` to read instructions without starting a shell or forwarding sandbox secret values. Text references under `references/` can use `.md`, `.txt` or `.json`. The registry verifies the exact archive's content CID before returning a declaration or document. Documents are limited to 64 KiB. Inspection refuses an unavailable endpoint, malformed response, substituted CID or substituted document path.

The registry must provide `GET /capsules/:cid/inspect`. Its read permission and private capsule isolation match archive download. The separate legacy private capsule service requires a service read key and does not provide this scoped UCAN inspection contract. This runtime does not forward that service key to agents.

## Execution checks

The author puts `skill-contract.json` inside the capsule. The declaration specifies its schema version, skill name, supported runtime and audiences, full workflow effects, required tool names and scheduling effects, capabilities, and service compatibility profiles. It cannot supply a grant, trusted origin, credential or user identity. The schema versions the declaration format. It does not invent tool implementation versions.

Before `load_skill` or a CID-bearing `sandbox_run`, the main agent reads the exact CID's inspection result and compares it with the tools currently available after capability, plugin and native authority checks. The host repeats that check for every call, including sub-agent tools and turn tools. A load requires the canonical `cid` argument. The wrapper preserves a CID even when an upstream schema would otherwise drop it. Missing tools, mismatched scheduling effects, unavailable inspection, unsupported runtimes and unsupported service profiles block forwarding. Legacy and unknown declarations remain reference-only through this gate.

The host checks declared capabilities at invocation. Sensitive host tools retain their existing authorization and revocation checks. This preflight does not authorize network calls made by arbitrary shell code. An object result carries `skillContractCheck.status: dependencies_checked`, `effectEnforced: false`, `mountIntegrity: unverified` and `authorization: host_tool_checks_required`. String results retain the upstream format. Dependency presence does not prove shell restrictions or mounted bytes.

Sandbox tool discovery omits user and oracle secret values. An allowed execution can establish its secret-bearing connection after preflight. General shell execution without a CID remains outside this capsule gate, including access to files already available to that sandbox. This change does not implement per-process network, filesystem or secret mediation.

## Audience and memory

The production host supplies a turn-scoped audience reader using current room participants. It is bound to the authenticated user, session and room. An absent or failed reader is shared. Private discovery and private instruction reads require a private audience and current registry authorization. Shared and unknown audiences query the public registry without a private invocation. A change to shared audience suppresses a private result.

Keep account and credit reads, live file lookup, personal memory and active-oracle knowledge on their bounded native tools. Reading a skill does not query either memory plane. Personal memory must not enter shared Topic context. Topic composition drafts remain distinct from committed Topics. The Library workflow retains its file writes; the YellowCard payment-block capsule retains its payment effects and does not become the user's USDC off-ramp quote tool.

## Search dependency

The existing [QiForge authorizer PR 325](https://github.com/ixoworld/qiforge/pull/325) and [Search Gateway delegated-auth PR 12](https://github.com/ixoworld/ixo-search-gateway/pull/12) own the search credential path. Stage 6 does not add another authorizer. The public skill pins their inspected source heads in its host reference.

At the inspected authorizer head, `search_gateway_authorize` lacks an explicit write effect. The scheduler infers read from its name. The skill requires write because the tool creates a single-use authorization and blob, so that descriptor does not pass this gate. Current gateway main supports self-issued authentication and cannot establish the delegated profile. Required service profiles remain unsupported until a trusted installed compatibility check exists. Source pins and synthetic tests cannot clear that requirement.

## Rollout and validation

This intentionally changes CID-based loading of old capsules. Deploy the registry inspection endpoint and publish reviewed contract-bearing capsules before enabling a consuming runtime release. Revert the runtime source to roll back this gate. Use only known, verified prior CIDs for capsule rollback. No rollback CID is inferred from a branch or Git commit.

Local core tests exercise actual wrappers, the composed agent, scope changes, missing dependencies, expiry, metadata substitution and secret-free discovery. The installed-package check runs native tools and shell-free inspection in workerd with a controlled registry response. These tests do not prove a hosted Companion run, a deployed gateway profile or sandbox mount integrity. The Companion package pin from Stage 5 does not include Stage 6 until its later conformance and release change.
