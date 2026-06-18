import { describe, expect, it } from 'vitest';
import { compileBaseUcanFlow, getActionByCan } from '@ixo/editor/core';
import { flowSpecToBaseUcan } from './translator.js';
import { getFlowTemplate, listTemplateNames } from './templates.js';

describe('flow templates', () => {
  it('lists the claim-and-notify starter', () => {
    expect(listTemplateNames()).toContain('claim-and-notify');
  });

  it('every template compiles against the action registry', () => {
    for (const name of listTemplateNames()) {
      const flow = getFlowTemplate(name);
      expect(flow).toBeDefined();
      expect(() =>
        compileBaseUcanFlow(flowSpecToBaseUcan(flow!, { flowId: name }), {
          getActionByCan,
        }),
      ).not.toThrow();
    }
  });

  it('returns a mutation-safe deep copy', () => {
    const a = getFlowTemplate('claim-and-notify');
    a!.title = 'changed';
    expect(getFlowTemplate('claim-and-notify')!.title).toBe(
      'Submit a Claim and Notify',
    );
  });

  it('returns undefined for an unknown template', () => {
    expect(getFlowTemplate('nope')).toBeUndefined();
  });
});
