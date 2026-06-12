/** Lifecycle stage a specialist role belongs to (see the readiness pipeline). */
export type DesignPodStage =
  | 'qualify'
  | 'architect'
  | 'build'
  | 'evaluate'
  | 'package'
  | 'gate';

/** A design-pod specialist role, 1:1 with a published ai-skills capsule. */
export interface DesignPodRole {
  /** Stable role id; the sub-agent tool the conductor sees is `call_<id>`. */
  id: string;
  /** Capsule name in the ai-skills registry (the published SKILL.md folder). */
  capsule: string;
  /** Short description surfaced to the conductor. */
  description: string;
  /** Lifecycle stage that gates when this role runs. */
  stage: DesignPodStage;
}

/**
 * The twelve specialist roles. `concierge` and `orchestration` are NOT here —
 * they are realised by the main-agent conductor (manifest + orchestration
 * tools), not as sub-agents, since sub-agents are leaves and cannot call peers.
 */
export const DESIGN_POD_ROLES = [
  {
    id: 'service_intent_scorer',
    capsule: 'design-pod-service-intent-scorer',
    description:
      'Scores and qualifies the incoming service intent (viability and fit).',
    stage: 'qualify',
  },
  {
    id: 'service_architect',
    capsule: 'design-pod-service-architect',
    description:
      'Designs the POD service structure: roles, workspaces, and services.',
    stage: 'architect',
  },
  {
    id: 'claims_architect',
    capsule: 'design-pod-claims-architect',
    description: 'Designs the claim schemas and the UDID model.',
    stage: 'architect',
  },
  {
    id: 'ucan_rights_architect',
    capsule: 'design-pod-ucan-rights-architect',
    description:
      'Designs the rights model: UCAN delegations and root documents.',
    stage: 'architect',
  },
  {
    id: 'flow_builder',
    capsule: 'design-pod-flow-builder',
    description:
      "Builds the Flow pages — the POD's executable workflow and UX.",
    stage: 'build',
  },
  {
    id: 'playbook_creation_agent',
    capsule: 'design-pod-playbook-creation-agent',
    description: 'Authors operating playbooks and rule cards.',
    stage: 'build',
  },
  {
    id: 'automation_feasibility_oracle',
    capsule: 'design-pod-automation-feasibility-oracle',
    description:
      'Evaluates what can be automated versus what needs a human in the loop.',
    stage: 'evaluate',
  },
  {
    id: 'governance_risk_oracle',
    capsule: 'design-pod-governance-risk-oracle',
    description: 'Evaluates the governance and risk posture.',
    stage: 'evaluate',
  },
  {
    id: 'outcome_contract_oracle',
    capsule: 'design-pod-outcome-contract-oracle',
    description:
      'Defines and evaluates the outcome contract (what success pays for).',
    stage: 'evaluate',
  },
  {
    id: 'commercial_packager',
    capsule: 'design-pod-commercial-packager',
    description:
      'Packages the commercial offer and drafts the marketplace listing.',
    stage: 'package',
  },
  {
    id: 'demo_builder',
    capsule: 'design-pod-demo-builder',
    description: 'Builds a runnable demo of the POD.',
    stage: 'package',
  },
  {
    id: 'qa_launch_readiness_oracle',
    capsule: 'design-pod-qa-launch-readiness-oracle',
    description: 'Runs final QA and the launch-readiness gate.',
    stage: 'gate',
  },
] as const satisfies readonly DesignPodRole[];
