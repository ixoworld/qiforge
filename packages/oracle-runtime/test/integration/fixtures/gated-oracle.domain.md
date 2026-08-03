---
version: '1.0.0-rc.3'
kind: 'domain.md'
conformance:
  spec_version: '1.0.0-rc.3'
  schema: 'urn:ixo:domain-md:schema:1.0.0-rc.3'
  profile: 'authoring_draft'
document_revision: '1.0.0'
domain:
  id: 'did:ixo:entity:integration-gated-oracle'
  iid: null
  type: 'oracle'
  status: 'active'
  purpose: 'Fixture constitution for the constitution-gate integration test.'
  operating_boundary: >-
    Exists only to be refused. Grants nothing beyond reading its own context,
    so any effectful tool call has no grant behind it.
constitution:
  status: 'in_force'
  reason: null
  subject: 'did:ixo:entity:integration-gated-oracle'
  type: 'con:OracleConstitution'
  execution:
    failure_policy: 'deny'
agent_default_mode:
  # High enough that the ceiling is not what refuses. The test is about the
  # gate reaching a decision on the grants, not about a mode check short-
  # circuiting before it — a refusal for the wrong reason would pass a test
  # that is meant to prove the gate works.
  mode: 'bounded_execute'
  overrides: {}
  human_review_required_for: []
rights:
  agent_baseline:
    require_explicit_grant_for:
      - 'write'
      - 'execute'
      - 'pay'
      - 'issue'
      - 'mint'
      - 'transfer'
      - 'govern'
      - 'delete'
      - 'revoke'
  entries: []
agents:
  entries:
    - id: 'did:ixo:entity:integration-gated-oracle'
      role: 'agentic_oracle'
      type: 'agentic_oracle'
      permitted_outputs: ['analysis', 'draft']
      forbidden_outputs: ['unbounded_payment', 'unreviewed_final_approval']
      escalation:
        human_role: 'operator'
        matrix_room: null
        timeout: 'PT24H'
critical_do_not:
  - 'Do not execute a state change; no grant in this document authorizes one.'
---

# domain.md

A fixture, not a template. It exists so an integration test can prove that a
tool the constitution does not authorize is refused **and does not run** — the
second half being the one a runtime could quietly fail while still logging a
convincing refusal.

`rights.entries` is deliberately empty. Every effectful action therefore falls
through to the baseline and is denied for want of a grant, which is the
simplest possible ground for a refusal and the hardest to reach by accident.
