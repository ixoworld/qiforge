/**
 * Request `metadata` → agent state, the Node runtime's `agent-builder` rules:
 *
 *  - `editorRoomId` / `spaceId` / `currentEntityDid` update the thread's
 *    checkpointed value when the request carries them, otherwise the prior
 *    value stands;
 *  - `sessionRunId` follows the room: a request that names the editor room
 *    also defines its session run, and "no run" must not fall back to one
 *    remembered from an earlier flow — so it is written whenever
 *    `editorRoomId` is, even as `undefined`;
 *  - an active editor context (room or space, from the request or the
 *    checkpoint) seeds the editor plugin into `loadedPlugins`, so its tools
 *    pass the capability gate without an explicit `load_capability` step.
 *
 * Metadata crosses the Durable Object boundary as a JSON string; only string
 * values are honoured, anything else is ignored.
 */

export const EDITOR_PLUGIN_NAME = 'editor';

export interface TurnMetadata {
  editorRoomId?: string;
  spaceId?: string;
  sessionRunId?: string;
  currentEntityDid?: string | null;
}

const KEYS = [
  'editorRoomId',
  'spaceId',
  'sessionRunId',
  'currentEntityDid',
] as const;

export function parseTurnMetadata(json: string | undefined): TurnMetadata {
  if (!json) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return {};
  const record: Record<string, unknown> = { ...parsed };
  const out: TurnMetadata = {};
  for (const key of KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  if (record.currentEntityDid === null) out.currentEntityDid = null;
  return out;
}

/** The checkpointed values the mapping falls back to. */
export interface PriorMetadataState {
  editorRoomId?: string;
  spaceId?: string;
  sessionRunId?: string;
  currentEntityDid?: string | null;
  loadedPlugins?: string[];
}

function priorString(
  prior: Record<string, unknown>,
  key: keyof PriorMetadataState,
): string | undefined {
  const value = prior[key];
  return typeof value === 'string' ? value : undefined;
}

export function priorMetadataState(
  prior: Record<string, unknown>,
): PriorMetadataState {
  const loaded = prior['loadedPlugins'];
  return {
    editorRoomId: priorString(prior, 'editorRoomId'),
    spaceId: priorString(prior, 'spaceId'),
    sessionRunId: priorString(prior, 'sessionRunId'),
    currentEntityDid: priorString(prior, 'currentEntityDid'),
    ...(Array.isArray(loaded)
      ? { loadedPlugins: loaded.filter((p) => typeof p === 'string') }
      : {}),
  };
}

export function editorContextActive(
  meta: TurnMetadata,
  prior: PriorMetadataState,
): boolean {
  return Boolean(
    (meta.editorRoomId ?? prior.editorRoomId) ||
    (meta.spaceId ?? prior.spaceId),
  );
}

/** Fields for the build-time state (`history.state`): request over checkpoint. */
export function metadataBuildState(
  meta: TurnMetadata,
  prior: PriorMetadataState,
): {
  editorRoomId?: string;
  sessionRunId?: string;
  spaceId?: string;
  currentEntityDid?: string | null;
  loadedPlugins: string[];
} {
  const loaded = prior.loadedPlugins ?? [];
  return {
    editorRoomId: meta.editorRoomId ?? prior.editorRoomId,
    sessionRunId:
      meta.editorRoomId !== undefined ? meta.sessionRunId : prior.sessionRunId,
    spaceId: meta.spaceId ?? prior.spaceId,
    currentEntityDid:
      meta.currentEntityDid !== undefined
        ? meta.currentEntityDid
        : prior.currentEntityDid,
    loadedPlugins: editorContextActive(meta, prior)
      ? Array.from(new Set([...loaded, EDITOR_PLUGIN_NAME]))
      : loaded,
  };
}

/** Fields for the graph input: only what THIS request carries is written. */
export function metadataGraphInput(
  meta: TurnMetadata,
  prior: PriorMetadataState,
): {
  editorRoomId?: string;
  sessionRunId?: string;
  spaceId?: string;
  currentEntityDid?: string | null;
  loadedPlugins?: string[];
} {
  return {
    ...(meta.editorRoomId !== undefined && {
      editorRoomId: meta.editorRoomId,
      // Written even when undefined so a room without a run clears the
      // checkpointed run id rather than keeping a stale one.
      sessionRunId: meta.sessionRunId,
    }),
    ...(meta.spaceId !== undefined && { spaceId: meta.spaceId }),
    ...(meta.currentEntityDid !== undefined && {
      currentEntityDid: meta.currentEntityDid,
    }),
    ...(editorContextActive(meta, prior) && {
      loadedPlugins: [EDITOR_PLUGIN_NAME],
    }),
  };
}
