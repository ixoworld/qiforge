/**
 * The write choke point: guard ordering, and that no refusal ever leaves a
 * mutation behind. No Matrix — the provider and the room-state reader are
 * stubbed to the two narrow interfaces `applyDocumentEdit` actually uses.
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';
import {
  GRANTED_POWER_LEVELS,
  UNGRANTED_POWER_LEVELS,
  makeSessionStub,
  makeWriterStub,
} from './__test-fixtures__/document-session.js';
import {
  applyDocumentEdit,
  canOracleWrite,
  isFlowAlias,
} from './content-session.js';
import { isEditorFailure, propNotEditable } from './failures.js';
import { readDocumentTitle } from './document-model.js';

/** A trivial write step that stamps a marker into the doc. */
function markerStep() {
  return {
    plan: () => ({ value: 'written' }),
    apply: (doc: Y.Doc, plan: { value: string }) => {
      doc.getMap('probe').set('marker', plan.value);
      return { ok: true as const, wrote: plan.value };
    },
  };
}

function wrote(doc: Y.Doc): boolean {
  return doc.getMap('probe').get('marker') === 'written';
}

describe('isFlowAlias', () => {
  it('recognises only flow aliases', () => {
    expect(isFlowAlias('#flow-did-ixo-abc-123:mx.test')).toBe(true);
    expect(isFlowAlias('#page-did-ixo-abc-123:mx.test')).toBe(false);
    expect(isFlowAlias(undefined)).toBe(false);
    expect(isFlowAlias('!room:mx.test')).toBe(false);
  });
});

describe('canOracleWrite', () => {
  it('is false when the oracle sits below the room write threshold', async () => {
    const session = makeSessionStub({ powerLevels: UNGRANTED_POWER_LEVELS });
    expect(await canOracleWrite(session)).toBe(false);
  });

  it('is true once the oracle has been granted a sufficient level', async () => {
    const session = makeSessionStub({ powerLevels: GRANTED_POWER_LEVELS });
    expect(await canOracleWrite(session)).toBe(true);
  });

  it('honours a per-event-type override for the CRDT update event', async () => {
    const session = makeSessionStub({
      powerLevels: {
        users_default: 0,
        events_default: 50,
        events: { 'matrix-crdt.doc_update': 0 },
      },
    });
    expect(await canOracleWrite(session)).toBe(true);
  });

  it('fails open when the power levels cannot be read', async () => {
    const session = makeSessionStub({ powerLevels: new Error('M_FORBIDDEN') });
    expect(await canOracleWrite(session)).toBe(true);
  });
});

describe('applyDocumentEdit: guard ordering', () => {
  it('refuses a live flow first, before anything else is consulted', async () => {
    // An un-writable provider and ungranted power levels are also present:
    // whichever guard could fire, the flow refusal must be the reported one.
    const session = makeSessionStub({
      isFlow: true,
      alias: '#flow-abc:mx.test',
      writer: makeWriterStub({ canWrite: false }),
      powerLevels: UNGRANTED_POWER_LEVELS,
    });

    const result = await applyDocumentEdit(session, markerStep());
    expect(isEditorFailure(result) && result.code).toBe('read_only_flow');
    expect(isEditorFailure(result) && result.message).toContain(
      '#flow-abc:mx.test',
    );
    expect(wrote(session.doc)).toBe(false);
    expect(session.writer.flushes).toBe(0);
  });

  it('refuses when the provider already knows it cannot write', async () => {
    const session = makeSessionStub({
      writer: makeWriterStub({ canWrite: false }),
    });
    const result = await applyDocumentEdit(session, markerStep());
    expect(isEditorFailure(result) && result.code).toBe('needs_access');
    expect(wrote(session.doc)).toBe(false);
    expect(session.writer.flushes).toBe(0);
  });

  it('refuses on an insufficient power level, before the allowlist runs', async () => {
    const session = makeSessionStub({ powerLevels: UNGRANTED_POWER_LEVELS });
    let planned = false;
    const result = await applyDocumentEdit(session, {
      plan: () => {
        planned = true;
        return {};
      },
      apply: () => ({ ok: true as const }),
    });

    expect(isEditorFailure(result) && result.code).toBe('needs_access');
    expect(planned).toBe(false);
    expect(session.writer.flushes).toBe(0);
  });

  it('names grant_assistant_access in the needs_access message', async () => {
    const session = makeSessionStub({
      writer: makeWriterStub({ canWrite: false }),
    });
    const result = await applyDocumentEdit(session, markerStep());
    expect(isEditorFailure(result) && result.message).toContain(
      'grant_assistant_access',
    );
  });

  it('returns the allowlist refusal from plan without mutating or flushing', async () => {
    const session = makeSessionStub();
    const result = await applyDocumentEdit(session, {
      plan: () =>
        propNotEditable('block-1', 'action', [
          { prop: 'conditions', reason: 'behavioural' },
        ]),
      apply: (doc: Y.Doc) => {
        doc.getMap('probe').set('marker', 'written');
        return { ok: true as const };
      },
    });

    expect(isEditorFailure(result) && result.code).toBe('prop_not_editable');
    expect(isEditorFailure(result) && result.props).toEqual(['conditions']);
    expect(isEditorFailure(result) && result.message).toContain('conditions');
    expect(wrote(session.doc)).toBe(false);
    expect(session.writer.flushes).toBe(0);
  });
});

describe('applyDocumentEdit: flush before success', () => {
  it('mutates in one transaction and awaits the flush before reporting success', async () => {
    const session = makeSessionStub();
    const origins: string[] = [];
    session.doc.on('afterTransaction', (transaction) => {
      origins.push(String(transaction.origin));
    });

    const result = await applyDocumentEdit(session, markerStep());

    expect(result).toEqual({ ok: true, wrote: 'written' });
    expect(wrote(session.doc)).toBe(true);
    expect(session.writer.flushes).toBe(1);
    // One transaction, tagged with the plugin's own origin.
    expect(origins).toEqual(['ixo-oracle-content-assistant']);
  });

  it('reports needs_access when the homeserver rejects the write during the flush', async () => {
    const session = makeSessionStub({
      writer: makeWriterStub({ rejectOnFlush: true }),
    });

    const result = await applyDocumentEdit(session, markerStep());

    // The local mutation happened but never reached the room — the tool must
    // not claim success. This is the bug the flush-before-success rule fixes.
    expect(wrote(session.doc)).toBe(true);
    expect(session.writer.flushes).toBe(1);
    expect(isEditorFailure(result) && result.code).toBe('needs_access');
    expect(isEditorFailure(result) && result.message).toContain(
      'grant_assistant_access',
    );
  });

  it('reports flush_timeout rather than success when the flush never settles', async () => {
    const session = makeSessionStub({ writer: makeWriterStub({ hang: true }) });

    vi.useFakeTimers();
    try {
      const pending = applyDocumentEdit(session, markerStep());
      // The bounded wait is 20s; past it the call must resolve to a failure
      // instead of hanging the tool call forever.
      await vi.advanceTimersByTimeAsync(20_001);
      const result = await pending;

      expect(isEditorFailure(result) && result.code).toBe('flush_timeout');
      expect(isEditorFailure(result) && result.message).toContain(
        'NOT applied',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('applyDocumentEdit: title seeding', () => {
  it('seeds an untitled document from the room name on the first write', async () => {
    // `create_page_room` sets `m.room.name`, but the editor renders its heading
    // from `yDoc.getText('title')` — without this the page opens untitled.
    const session = makeSessionStub({ roomName: 'Tuesday standup notes' });

    const result = await applyDocumentEdit(session, markerStep());

    expect(isEditorFailure(result)).toBe(false);
    expect(wrote(session.doc)).toBe(true);
    expect(readDocumentTitle(session.doc)).toBe('Tuesday standup notes');
  });

  it('never overwrites a title the document already has', async () => {
    const session = makeSessionStub({ roomName: 'Room name' });
    session.doc.getText('title').insert(0, 'The title the user chose');

    await applyDocumentEdit(session, markerStep());

    expect(readDocumentTitle(session.doc)).toBe('The title the user chose');
  });

  it('writes normally when the room has no name', async () => {
    const session = makeSessionStub();

    const result = await applyDocumentEdit(session, markerStep());

    expect(isEditorFailure(result)).toBe(false);
    expect(wrote(session.doc)).toBe(true);
    expect(readDocumentTitle(session.doc)).toBe('');
  });

  it('does not seed a title when the edit is refused', async () => {
    // The seed must never be the only thing a refused write leaves behind.
    const session = makeSessionStub({
      roomName: 'Should not appear',
      powerLevels: UNGRANTED_POWER_LEVELS,
    });

    const result = await applyDocumentEdit(session, markerStep());

    expect(isEditorFailure(result)).toBe(true);
    expect(wrote(session.doc)).toBe(false);
    expect(readDocumentTitle(session.doc)).toBe('');
  });
});
