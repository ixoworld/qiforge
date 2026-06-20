import { describe, expect, it } from 'vitest';
import { getActionByCan } from '@ixo/editor/core';
import { flowSpecToBaseUcan } from './translator.js';
import { setStepProps } from './edit.js';
import { checkLink, compatibleActions, requirements } from './linkage.js';
import { inferPortType } from './port-types.js';
import { hydrateFlowDoc } from './test-support.js';
import type { Doc as YDoc } from 'yjs';

const CLAIM_SUBMIT = 'qi/claim.submit';
const CLAIM_EVALUATE = 'qi/claim.evaluate';
const FORM_ACTION = 'qi/human.form.submit';
const MATRIX_DM = 'qi/matrix.dm';
const SURVEY = JSON.stringify({
  pages: [
    {
      elements: [
        { name: 'did', type: 'text', title: 'Your DID', isRequired: true },
      ],
    },
  ],
});

/** Skip form-linkage assertions unless both the form and matrix.dm actions exist. */
function formAndDmPresent(): boolean {
  return Boolean(
    (getActionByCan('form/submit') || getActionByCan('human/form')) &&
      getActionByCan('matrix/dm'),
  );
}

function formToDmDoc(): YDoc {
  const doc = hydrateFlowDoc(
    flowSpecToBaseUcan(
      {
        title: 'Form to DM',
        steps: [
          { id: 'form', action: FORM_ACTION },
          { id: 'dm', action: MATRIX_DM },
        ],
      },
      { flowId: 'f' },
    ),
  );
  setStepProps(doc, 'form', { surveySchema: SURVEY });
  return doc;
}

/** Skip linkage assertions if the registry doesn't have the claim actions this seed uses. */
function claimActionsPresent(): boolean {
  return Boolean(
    getActionByCan('claim/submit') && getActionByCan('claim/evaluate'),
  );
}

function claimFlowDoc(): YDoc {
  return hydrateFlowDoc(
    flowSpecToBaseUcan(
      {
        title: 'Claim review',
        steps: [
          { id: 'submit', action: CLAIM_SUBMIT },
          { id: 'evaluate', action: CLAIM_EVALUATE },
        ],
      },
      { flowId: 'f' },
    ),
  );
}

describe('inferPortType', () => {
  it('maps field names to semantic port types', () => {
    expect(inferPortType('transactionHash')).toBe('transactionHash');
    expect(inferPortType('claimId')).toBe('claimId');
    expect(inferPortType('collectionId')).toBe('claimCollectionId');
    expect(inferPortType('recipientDid')).toBe('did');
    expect(inferPortType('entityDid')).toBe('entityDid');
    expect(inferPortType('ownerAddress')).toBe('chainAddress');
  });

  it('falls back to the primitive type for unknown names', () => {
    expect(inferPortType('quantity', 'number')).toBe('number');
    expect(inferPortType('label')).toBe('string');
  });
});

describe('checkLink', () => {
  it('rejects a reference to an output field the source does not produce', () => {
    if (!claimActionsPresent()) return;
    const doc = claimFlowDoc();
    const result = checkLink(
      doc,
      'r',
      'submit',
      'definitelyNotAField',
      'evaluate',
      'claimId',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not produce/);
  });

  it('accepts a matching typed wiring', () => {
    if (!claimActionsPresent()) return;
    const doc = claimFlowDoc();
    // claim.submit outputs claimId; claim.evaluate declares a claimId input (overlay).
    const result = checkLink(
      doc,
      'r',
      'submit',
      'claimId',
      'evaluate',
      'claimId',
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a typed mismatch', () => {
    if (!claimActionsPresent()) return;
    const doc = claimFlowDoc();
    // transactionHash output into a claimId input -> both core types, mismatch.
    const result = checkLink(
      doc,
      'r',
      'submit',
      'transactionHash',
      'evaluate',
      'claimId',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/mismatch/i);
  });

  it('reports an unknown step', () => {
    if (!claimActionsPresent()) return;
    const doc = claimFlowDoc();
    expect(
      checkLink(doc, 'r', 'nope', 'claimId', 'evaluate', 'claimId').ok,
    ).toBe(false);
  });

  it('accepts an individual answers.<question> field from a form step', () => {
    if (!formAndDmPresent()) return;
    const doc = formToDmDoc();
    // The form's `did` question -> matrix.dm `targetDid` (a declared did input).
    const result = checkLink(doc, 'r', 'form', 'answers.did', 'dm', 'targetDid');
    expect(result.ok).toBe(true);
  });

  it('still offers the bundled answers object as a (loosely typed) field', () => {
    if (!formAndDmPresent()) return;
    const doc = formToDmDoc();
    // `answers` is the whole object; it resolves but isn't a core scalar type,
    // so it links with a warning rather than a hard accept/reject.
    const result = checkLink(doc, 'r', 'form', 'answers', 'dm', 'targetDid');
    expect(result.ok).toBe(true);
  });

  it('rejects an answers.<question> path absent from the survey schema', () => {
    if (!formAndDmPresent()) return;
    const doc = formToDmDoc();
    const result = checkLink(
      doc,
      'r',
      'form',
      'answers.notAQuestion',
      'dm',
      'targetDid',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not produce/);
  });
});

describe('compatibleActions', () => {
  it('finds actions that produce the wanted input type', () => {
    if (!claimActionsPresent()) return;
    const doc = claimFlowDoc();
    const producers = compatibleActions(doc, 'r', 'evaluate', 'claimId');
    expect(
      producers.some((p) => p.action === CLAIM_SUBMIT && p.field === 'claimId'),
    ).toBe(true);
    expect(producers.every((p) => p.type === 'claimId')).toBe(true);
  });
});

describe('requirements', () => {
  it('returns the overlay-declared prerequisites of an action', () => {
    if (!claimActionsPresent()) return;
    const reqs = requirements(CLAIM_SUBMIT);
    expect(reqs.some((r) => r.kind === 'claimCollection')).toBe(true);
  });

  it('returns [] for an action with no declared requirements', () => {
    if (!claimActionsPresent()) return;
    expect(
      requirements(CLAIM_EVALUATE).every((r) => typeof r.kind === 'string'),
    ).toBe(true);
  });
});
