import { describe, expect, it } from 'vitest';
import type { TurnRequest } from './contracts';
import { clientSurfaceFor, storedRunRequest } from './run-request';

const req: TurnRequest = {
  identity: { userDid: 'did:ixo:user', timezone: 'UTC' },
  sessionId: 's1',
  message: 'open the reports page',
  client: 'portal',
  requestId: 'r1',
};

const tools = [
  {
    name: 'open_url',
    description: 'Open a URL in the user tab',
    schema: { type: 'object', properties: { url: { type: 'string' } } },
  },
];
const agActions = [
  {
    name: 'show_chart',
    description: 'Render a chart',
    schema: { type: 'object' },
    hasRender: true,
  },
];

describe('storedRunRequest', () => {
  it('keeps the browser tools and AG-UI actions the client declared', () => {
    const stored = storedRunRequest(req, { tools, agActions, stream: true });
    expect(stored.tools).toEqual(tools);
    expect(stored.agActions).toEqual(agActions);
  });

  it('omits the surface fields when the client declared none', () => {
    const stored = storedRunRequest(req, { stream: true });
    expect(stored).not.toHaveProperty('tools');
    expect(stored).not.toHaveProperty('agActions');
  });
});

describe('clientSurfaceFor', () => {
  const prior = {
    browserTools: [{ name: 'old_tool', description: 'x', schema: {} }],
    agActions: [{ name: 'old_action', description: 'y', schema: {} }],
  };

  it('uses the surface the body carries and writes it to the graph input', () => {
    const surface = clientSurfaceFor({ tools, agActions }, prior);
    expect(surface.state).toEqual({ browserTools: tools, agActions });
    expect(surface.input).toEqual({ browserTools: tools, agActions });
  });

  it('falls back to the checkpointed surface without rewriting it', () => {
    const surface = clientSurfaceFor({}, prior);
    expect(surface.state).toEqual(prior);
    expect(surface.input).toEqual({});
  });

  it('starts empty when neither the body nor the checkpoint declares one', () => {
    const surface = clientSurfaceFor({}, {});
    expect(surface.state).toEqual({ browserTools: [], agActions: [] });
    expect(surface.input).toEqual({});
  });
});
