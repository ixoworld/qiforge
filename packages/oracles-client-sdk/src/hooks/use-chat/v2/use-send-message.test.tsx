// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type PropsWithChildren, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { z as z3 } from 'zod/v3';
import type { IOraclesContextProps } from '../../../providers/oracles-provider/types.js';
import type { IBrowserTools } from '../../../types/browser-tool.type.js';
import { OracleChat } from './oracle-chat.js';
import { useSendMessage } from './use-send-message.js';

type RenewOracleAuth = IOraclesContextProps['renewOracleAuth'];

const API = 'https://oracle.test';
const ORACLE = 'did:ixo:oracle';

let context: IOraclesContextProps;
vi.mock('../../../providers/oracles-provider/oracles-context.js', () => ({
  useOraclesContext: () => context,
}));
vi.mock('../../use-oracles-config.js', () => ({
  useOraclesConfig: () => ({ config: { apiUrl: API }, isReady: true }),
}));

function makeContext(
  overrides: Partial<IOraclesContextProps> = {},
): IOraclesContextProps {
  return {
    wallet: {
      did: 'did:ixo:user-a',
      address: 'ixo1usera',
      matrix: { accessToken: 'mx', homeServer: 'hs' },
    },
    transactSignX: vi.fn(),
    authedRequest: vi.fn(),
    getDelegation: vi.fn(async () => 'delegation'),
    getInvocation: vi.fn(async () => 'inv-1'),
    renewOracleAuth: vi.fn(async () => true),
    agActions: [],
    registeredAgActions: [],
    registerAgAction: vi.fn(),
    unregisterAgAction: vi.fn(),
    executeAgAction: vi.fn(),
    getAgActionRender: vi.fn(),
    ...overrides,
  };
}

/** The first delegation waits for the test to release it; later ones are immediate. */
function delegationHeldOnce() {
  let releaseDelegation!: (value: string) => void;
  let first = true;
  const getDelegation = vi.fn(() => {
    if (!first) return Promise.resolve('delegation');
    first = false;
    return new Promise<string>((resolve) => {
      releaseDelegation = resolve;
    });
  });
  return {
    getDelegation,
    releaseDelegation: (value: string) => releaseDelegation(value),
  };
}

const frame = (event: string, id: number, data: unknown) =>
  `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;

/** An SSE body the test writes to; a fetch abort errors it, as a real body. */
function controlledBody(signal: AbortSignal | null | undefined) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  signal?.addEventListener('abort', () => {
    try {
      controller.error(
        Object.assign(new Error('aborted'), { name: 'AbortError' }),
      );
    } catch {
      /* already closed */
    }
  });
  return {
    body,
    write: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    close: () => controller.close(),
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  signal: AbortSignal | null | undefined;
  body: string | undefined;
}

function setup(
  chat: OracleChat,
  refetchQueries = vi.fn(async () => {}),
  strict = false,
  browserTools?: IBrowserTools,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: PropsWithChildren) => {
    const tree = (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  };
  // Stable across renders, as `useChat`'s ref is.
  const chatRef = { current: chat };
  return renderHook(
    () =>
      useSendMessage({
        oracleDid: ORACLE,
        sessionId: 'sess',
        onPaymentRequiredError: () => undefined,
        chatRef,
        refetchQueries,
        browserTools,
      }),
    { wrapper },
  );
}

const newChat = () =>
  new OracleChat({
    oracleDid: ORACLE,
    sessionId: 'sess',
    onPaymentRequiredError: () => undefined,
  });

describe('useSendMessage', () => {
  let calls: Call[];
  let respond: (call: Call) => Response;
  let posts: ReturnType<typeof controlledBody>[];

  beforeEach(() => {
    calls = [];
    posts = [];
    respond = () => new Response('', { status: 500 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const call: Call = {
          url,
          method: init.method ?? 'GET',
          headers: Object.fromEntries(new Headers(init.headers)),
          signal: init.signal,
          body: typeof init.body === 'string' ? init.body : undefined,
        };
        calls.push(call);
        return respond(call);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** POSTs open a stream with the run frame; the test drives the rest. */
  const openPost = (call: Call, runId = 'run-new') => {
    const post = controlledBody(call.signal);
    posts.push(post);
    post.write(
      frame('run', 1, { runId, sessionId: 'sess', requestId: 'req-1' }),
    );
    return new Response(post.body, {
      headers: { 'x-request-id': 'req-1', 'x-run-id': runId },
    });
  };

  it('re-joins with a freshly minted invocation after a 401 and never repeats the POST', async () => {
    let current = 'inv-1';
    const renewOracleAuth = vi.fn(async (_did: string, stage: 1 | 2) => {
      if (stage === 1) current = 'inv-2';
      return true;
    });
    context = makeContext({
      getInvocation: vi.fn(async () => current),
      renewOracleAuth,
    });
    respond = (call) => {
      if (call.method === 'POST') return openPost(call);
      if (call.headers.authorization !== 'Bearer inv-2')
        return new Response('', { status: 401 });
      return new Response(
        frame('message', 3, { content: 'world', timestamp: 't' }) +
          frame('done', 4, { status: 'finished' }),
      );
    };
    const chat = newChat();
    const { result } = setup(chat);

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.sendMessage('hi');
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    posts[0]!.write(frame('message', 2, { content: 'hello ', timestamp: 't' }));
    posts[0]!.close(); // the connection drops mid-reply
    await act(async () => {
      await sending;
    });

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    const joins = calls.filter((c) => c.method === 'GET');
    expect(joins.map((c) => c.url)).toEqual([
      `${API}/runs/run-new?after=2`,
      `${API}/runs/run-new?after=2`,
    ]);
    expect(joins.map((c) => c.headers.authorization)).toEqual([
      'Bearer inv-1',
      'Bearer inv-2',
    ]);
    // Told which credentials were refused; the delegation stage never ran.
    expect(renewOracleAuth.mock.calls).toEqual([
      [ORACLE, 1, { delegation: 'delegation', invocation: 'inv-1' }],
    ]);
    expect(chat.run.ended).toBe('done');
    expect(chat.lastMessage?.content).toBe('hello world');
  });

  it('surfaces a re-join that is refused after both renewal stages', async () => {
    const renewOracleAuth = vi.fn<RenewOracleAuth>(async () => true);
    context = makeContext({ renewOracleAuth });
    respond = (call) =>
      call.method === 'POST'
        ? openPost(call)
        : new Response('', { status: 401 });
    const chat = newChat();
    const { result } = setup(chat);

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.sendMessage('hi');
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    posts[0]!.close();
    await act(async () => {
      await sending;
    });

    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(3);
    expect(renewOracleAuth.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [ORACLE, 1],
      [ORACLE, 2],
    ]);
    expect(chat.run.ended).toBe('unauthorized');
    expect(chat.status).toBe('error');
    expect(chat.error).toBeInstanceOf(Error);
  });

  it('a POST refused for its credentials is sent again once with renewed ones, and the message streams once', async () => {
    let current = 'inv-1';
    const renewOracleAuth = vi.fn(async (_did: string, stage: 1 | 2) => {
      if (stage === 1) current = 'inv-2';
      return true;
    });
    context = makeContext({
      getInvocation: vi.fn(async () => current),
      renewOracleAuth,
    });
    respond = (call) => {
      if (call.method !== 'POST') return new Response('');
      if (call.headers.authorization !== 'Bearer inv-2')
        return Response.json(
          { statusCode: 401, message: 'Invalid UCAN invocation' },
          { status: 401 },
        );
      return openPost(call);
    };
    const chat = newChat();
    const { result } = setup(chat);

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.sendMessage('hi');
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    posts[0]!.write(
      frame('message', 2, { content: 'hello', timestamp: 't' }) +
        frame('done', 3, { status: 'finished' }),
    );
    await act(async () => {
      await sending;
    });

    const sent = calls.filter((c) => c.method === 'POST');
    expect(sent.map((c) => c.headers.authorization)).toEqual([
      'Bearer inv-1',
      'Bearer inv-2',
    ]);
    expect(sent[1]!.body).toBe(sent[0]!.body);
    expect(renewOracleAuth.mock.calls.map((call) => call[1])).toEqual([1]);
    expect(chat.run.ended).toBe('done');
    expect(chat.lastMessage?.content).toBe('hello');
  });

  it('a POST still refused after both stages fails the send with the refusal', async () => {
    const renewOracleAuth = vi.fn<RenewOracleAuth>(async () => true);
    context = makeContext({ renewOracleAuth });
    respond = () =>
      Response.json(
        { statusCode: 401, message: 'Invalid UCAN invocation' },
        { status: 401 },
      );
    const chat = newChat();
    const { result } = setup(chat);

    let failure: unknown;
    await act(async () => {
      failure = await result.current.sendMessage('hi').catch((e: unknown) => e);
    });

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(3);
    expect(renewOracleAuth.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    expect(failure).toMatchObject({ status: 401 });
    expect(chat.status).toBe('error');
  });

  it('a resume that finishes waiting for its delegation after a send started leaves the send alone', async () => {
    const { getDelegation, releaseDelegation } = delegationHeldOnce();
    context = makeContext({ getDelegation });
    respond = (call) =>
      call.method === 'POST'
        ? openPost(call)
        : new Response(frame('done', 9, {}));
    const chat = newChat();
    const { result } = setup(chat);

    let resuming!: Promise<void>;
    act(() => {
      resuming = result.current.resumeRun('run-old');
    });
    act(() => {
      void result.current.sendMessage('hi');
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    await act(async () => {
      releaseDelegation('delegation');
      await resuming;
    });

    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.signal?.aborted).toBe(false);
    expect(calls.filter((c) => c.url.includes('/runs/run-old'))).toEqual([]);
    expect(chat.status).toBe('streaming');
  });

  it('a resume still waiting for its delegation when the chat unmounts opens no stream', async () => {
    const { getDelegation, releaseDelegation } = delegationHeldOnce();
    context = makeContext({ getDelegation });
    respond = () => new Response(frame('done', 9, {}));
    const refetchQueries = vi.fn(async () => {});
    const { result, unmount } = setup(newChat(), refetchQueries);

    let resuming!: Promise<void>;
    act(() => {
      resuming = result.current.resumeRun('run-old');
    });
    unmount();
    releaseDelegation('delegation');
    await resuming;

    expect(calls.filter((c) => c.url.includes('/runs/'))).toEqual([]);
    expect(refetchQueries).not.toHaveBeenCalled();
  });

  it('a message whose chat unmounts while its credentials are minted is not sent', async () => {
    const { getDelegation, releaseDelegation } = delegationHeldOnce();
    context = makeContext({ getDelegation });
    respond = (call) =>
      call.method === 'POST' ? openPost(call) : new Response('');
    const refetchQueries = vi.fn(async () => {});
    const { result, unmount } = setup(newChat(), refetchQueries);

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.sendMessage('hi');
    });
    await waitFor(() => expect(getDelegation).toHaveBeenCalled());
    unmount();
    releaseDelegation('delegation');
    // A POST sent now would hold its stream open with nothing to abort it.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toEqual([]);
    await sending;
    expect(refetchQueries).not.toHaveBeenCalled();
  });

  it('unmounting mid-reply stops following the stream and does not re-join or refetch', async () => {
    context = makeContext();
    respond = (call) =>
      call.method === 'POST'
        ? openPost(call)
        : new Response(frame('done', 9, {}));
    const refetchQueries = vi.fn(async () => {});
    const chat = newChat();
    const { result, unmount } = setup(chat, refetchQueries);

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.sendMessage('hi');
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    unmount();
    await sending;

    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.signal?.aborted).toBe(true);
    expect(calls.filter((c) => c.method === 'GET')).toEqual([]);
    expect(refetchQueries).not.toHaveBeenCalled();
  });

  it('under StrictMode a message still streams to its end and refreshes the history', async () => {
    context = makeContext();
    respond = (call) =>
      call.method === 'POST' ? openPost(call) : new Response('');
    const refetchQueries = vi.fn(async () => {});
    const chat = newChat();
    const { result } = setup(chat, refetchQueries, true);

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.sendMessage('hi');
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    posts[0]!.write(
      frame('message', 2, { content: 'hello', timestamp: 't' }) +
        frame('done', 3, { status: 'finished' }),
    );
    await act(async () => {
      await sending;
    });

    expect(calls.find((c) => c.method === 'POST')!.signal?.aborted).toBe(false);
    expect(chat.run.ended).toBe('done');
    expect(chat.lastMessage?.content).toBe('hello');
    expect(refetchQueries).toHaveBeenCalledTimes(1);
  });

  it("advertises an AG-UI action's zod schema as its JSON Schema, reused parts inlined", async () => {
    const row = z.object({ label: z.string(), value: z.number() });
    context = makeContext({
      agActions: [
        {
          name: 'create_data_table',
          description: 'Create a table',
          parameters: z.object({ header: row, rows: z.array(row) }),
          hasRender: false,
        },
      ],
    });
    respond = (call) =>
      call.method === 'POST' ? openPost(call) : new Response('');
    const { result } = setup(newChat());

    act(() => {
      void result.current.sendMessage('hi');
    });
    await waitFor(() => expect(posts).toHaveLength(1));

    const body: {
      agActions: { name: string; schema: Record<string, unknown> }[];
    } = JSON.parse(calls.find((c) => c.method === 'POST')!.body ?? '{}');
    const rowSchema = {
      type: 'object',
      properties: { label: { type: 'string' }, value: { type: 'number' } },
      required: ['label', 'value'],
    };
    expect(body.agActions[0]!.schema).toMatchObject({
      type: 'object',
      properties: {
        header: rowSchema,
        rows: { type: 'array', items: rowSchema },
      },
      required: ['header', 'rows'],
    });
    expect(JSON.stringify(body.agActions[0]!.schema)).not.toContain('$ref');
  });

  it("advertises a browser tool's zod 4 schema with its parameters", async () => {
    context = makeContext();
    respond = (call) =>
      call.method === 'POST' ? openPost(call) : new Response('');
    const { result } = setup(newChat(), undefined, false, {
      readLocalStorage: {
        toolName: 'readLocalStorage',
        description: 'Read a localStorage entry',
        schema: z.object({ key: z.string() }),
        fn: async () => null,
      },
    });

    act(() => {
      void result.current.sendMessage('hi');
    });
    await waitFor(() => expect(posts).toHaveLength(1));

    const body: {
      tools: {
        name: string;
        schema: { properties?: Record<string, unknown> };
      }[];
    } = JSON.parse(calls.find((c) => c.method === 'POST')!.body ?? '{}');
    expect(body.tools[0]!.name).toBe('readLocalStorage');
    expect(body.tools[0]!.schema.properties?.key).toEqual({ type: 'string' });
  });

  it('still advertises a browser tool declared with a zod/v3 schema', async () => {
    context = makeContext();
    respond = (call) =>
      call.method === 'POST' ? openPost(call) : new Response('');
    const { result } = setup(newChat(), undefined, false, {
      readLocalStorage: {
        toolName: 'readLocalStorage',
        description: 'Read a localStorage entry',
        schema: z3.object({ key: z3.string() }),
        fn: async () => null,
      },
    });

    act(() => {
      void result.current.sendMessage('hi');
    });
    await waitFor(() => expect(posts).toHaveLength(1));

    const body: {
      tools: { schema: { properties?: Record<string, unknown> } }[];
    } = JSON.parse(calls.find((c) => c.method === 'POST')!.body ?? '{}');
    expect(body.tools[0]!.schema.properties?.key).toEqual({ type: 'string' });
  });

  it('Stop uses the current wallet and oracle request function, not the one from the first render', async () => {
    const firstAuthed = vi.fn();
    const nextAuthed = vi.fn();
    context = makeContext({ authedRequest: firstAuthed });
    respond = (call) =>
      call.method === 'POST' ? openPost(call) : new Response('');
    const chat = newChat();
    const { result, rerender } = setup(chat);

    act(() => {
      void result.current.sendMessage('hi');
    });
    await waitFor(() => expect(posts).toHaveLength(1));

    context = makeContext({ authedRequest: nextAuthed });
    rerender();
    await act(async () => {
      await result.current.abortStream();
    });

    expect(firstAuthed).not.toHaveBeenCalled();
    expect(nextAuthed).toHaveBeenCalledWith(
      `${API}/messages/abort`,
      'POST',
      expect.anything(),
      ORACLE,
    );
  });
});
