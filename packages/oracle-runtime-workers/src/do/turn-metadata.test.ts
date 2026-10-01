import { describe, expect, it } from 'vitest';
import {
  EDITOR_PLUGIN_NAME,
  metadataBuildState,
  metadataGraphInput,
  parseTurnMetadata,
  priorMetadataState,
} from './turn-metadata';

describe('parseTurnMetadata', () => {
  it('keeps only the known string fields', () => {
    expect(
      parseTurnMetadata(
        JSON.stringify({
          editorRoomId: '!room:x',
          spaceId: '!space:x',
          sessionRunId: 'run-1',
          currentEntityDid: 'did:ixo:entity:1',
          other: 'ignored',
          editorRoomIdNumber: 5,
        }),
      ),
    ).toEqual({
      editorRoomId: '!room:x',
      spaceId: '!space:x',
      sessionRunId: 'run-1',
      currentEntityDid: 'did:ixo:entity:1',
    });
    expect(parseTurnMetadata(JSON.stringify({ editorRoomId: 7 }))).toEqual({});
    expect(parseTurnMetadata(JSON.stringify({ editorRoomId: '' }))).toEqual({});
  });

  it('tolerates missing, malformed and non-object metadata', () => {
    expect(parseTurnMetadata(undefined)).toEqual({});
    expect(parseTurnMetadata('{not json')).toEqual({});
    expect(parseTurnMetadata('[1]')).toEqual({});
    expect(parseTurnMetadata('"str"')).toEqual({});
  });
});

describe('metadata → state (Node agent-builder rules)', () => {
  const prior = priorMetadataState({
    editorRoomId: '!old:x',
    sessionRunId: 'run-old',
    spaceId: '!space-old:x',
    currentEntityDid: 'did:ixo:entity:old',
    loadedPlugins: ['memory'],
    ignored: 42,
  });

  it('a request that names the editor room also defines its run, even as none', () => {
    const withRun = metadataBuildState(
      { editorRoomId: '!new:x', sessionRunId: 'run-new' },
      prior,
    );
    expect(withRun.editorRoomId).toBe('!new:x');
    expect(withRun.sessionRunId).toBe('run-new');

    const noRun = metadataBuildState({ editorRoomId: '!new:x' }, prior);
    expect(noRun.sessionRunId).toBeUndefined();
    expect(metadataGraphInput({ editorRoomId: '!new:x' }, prior)).toMatchObject(
      { editorRoomId: '!new:x', sessionRunId: undefined },
    );
    expect(
      Object.keys(metadataGraphInput({ editorRoomId: '!new:x' }, prior)),
    ).toContain('sessionRunId');
  });

  it('without an editor room the checkpointed room and run stand', () => {
    const state = metadataBuildState({ sessionRunId: 'stray' }, prior);
    expect(state.editorRoomId).toBe('!old:x');
    expect(state.sessionRunId).toBe('run-old');
    const input = metadataGraphInput({ sessionRunId: 'stray' }, prior);
    expect(input).not.toHaveProperty('editorRoomId');
    expect(input).not.toHaveProperty('sessionRunId');
  });

  it('space and entity follow request-over-checkpoint', () => {
    expect(metadataBuildState({}, prior)).toMatchObject({
      spaceId: '!space-old:x',
      currentEntityDid: 'did:ixo:entity:old',
    });
    expect(
      metadataBuildState(
        { spaceId: '!s:x', currentEntityDid: 'did:ixo:entity:new' },
        prior,
      ),
    ).toMatchObject({
      spaceId: '!s:x',
      currentEntityDid: 'did:ixo:entity:new',
    });
    expect(metadataGraphInput({ spaceId: '!s:x' }, prior)).toEqual({
      spaceId: '!s:x',
      loadedPlugins: [EDITOR_PLUGIN_NAME],
    });
  });

  it('seeds the editor plugin only while an editor context is active', () => {
    expect(metadataBuildState({}, prior).loadedPlugins).toEqual([
      'memory',
      EDITOR_PLUGIN_NAME,
    ]);
    const bare = priorMetadataState({ loadedPlugins: ['memory'] });
    expect(metadataBuildState({}, bare).loadedPlugins).toEqual(['memory']);
    expect(metadataGraphInput({}, bare)).toEqual({});
    expect(
      metadataBuildState({ editorRoomId: '!r:x' }, bare).loadedPlugins,
    ).toEqual(['memory', EDITOR_PLUGIN_NAME]);
    expect(
      metadataBuildState(
        {},
        priorMetadataState({
          loadedPlugins: [EDITOR_PLUGIN_NAME],
          spaceId: '!s:x',
        }),
      ).loadedPlugins,
    ).toEqual([EDITOR_PLUGIN_NAME]);
  });
});
