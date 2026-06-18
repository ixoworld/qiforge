/**
 * In-plugin starter templates (spec §7.4) — authored directly as FlowSpec, so
 * there is zero editor dependency. `get_flow_template` returns one of these as
 * a starting point the agent can tweak and then `create_flow`. Each template
 * uses real registry actions and real output references (the templates.test
 * suite compiles every one against the registry).
 */
import type { FlowSpecInput } from './types.js';

const TEMPLATES: Record<string, FlowSpecInput> = {
  'claim-and-notify': {
    title: 'Submit a Claim and Notify',
    goal: 'Submit a claim, then email a notification once it has been recorded.',
    steps: [
      {
        id: 'submit-claim',
        action: 'qi/claim.submit',
        title: 'Submit Claim',
        description: 'Submit a claim to the collection.',
      },
      {
        id: 'notify',
        action: 'qi/email.send',
        title: 'Notify by Email',
        description: 'Email a confirmation once the claim has been recorded.',
        after: ['submit-claim'],
        inputs: {
          to: '',
          subject: 'Your claim was submitted',
          body: 'Claim {{submit-claim.output.claimId}} has been recorded.',
        },
      },
    ],
  },
};

export function listTemplateNames(): string[] {
  return Object.keys(TEMPLATES);
}

export function getFlowTemplate(name: string): FlowSpecInput | undefined {
  const template = TEMPLATES[name];
  // Return a deep copy so the caller can mutate it freely.
  return template
    ? (JSON.parse(JSON.stringify(template)) as FlowSpecInput)
    : undefined;
}
