import { describe, expect, it } from 'vitest';
import { getAllActions, typeToCan } from '@ixo/editor/core';
import { flowSpecToBaseUcan } from './translator.js';
import { listReferenceableFields } from './references.js';
import { hydrateFlowDoc, someActionType } from './test-support.js';

/** An action that declares a non-empty output schema, if the registry has one. */
function actionWithOutputs(): { type: string; fields: string[] } | undefined {
  const def = getAllActions().find(
    (a) =>
      typeof typeToCan(a.type) === 'string' &&
      Array.isArray(a.outputSchema) &&
      a.outputSchema.length > 0,
  );
  return def
    ? { type: def.type, fields: (def.outputSchema ?? []).map((f) => f.path) }
    : undefined;
}

describe('listReferenceableFields', () => {
  it('returns upstream output fields for a downstream step', () => {
    const producer = actionWithOutputs();
    if (!producer) return; // No action in the registry declares outputs — nothing to assert.

    const consumer = someActionType();
    const doc = hydrateFlowDoc(
      flowSpecToBaseUcan(
        {
          title: 'Pipe',
          steps: [
            { id: 'src', action: producer.type },
            { id: 'dst', action: consumer },
          ],
        },
        { flowId: 'f' },
      ),
    );

    const fields = listReferenceableFields(doc, 'r', 'dst');
    expect(fields.every((f) => f.fromStep === 'src')).toBe(true);
    for (const path of producer.fields) {
      expect(fields.some((f) => f.field === path)).toBe(true);
    }
  });

  it('only offers fields from steps that come before the target', () => {
    const action = someActionType();
    const doc = hydrateFlowDoc(
      flowSpecToBaseUcan(
        {
          title: 'Order',
          steps: [
            { id: 'a', action },
            { id: 'b', action },
            { id: 'c', action },
          ],
        },
        { flowId: 'f' },
      ),
    );
    // `a` is first, so it can reference nothing upstream.
    expect(listReferenceableFields(doc, 'r', 'a')).toEqual([]);
    // `c` can only reference `a` and `b`.
    const forC = listReferenceableFields(doc, 'r', 'c');
    expect(forC.every((f) => f.fromStep === 'a' || f.fromStep === 'b')).toBe(
      true,
    );
  });
});
