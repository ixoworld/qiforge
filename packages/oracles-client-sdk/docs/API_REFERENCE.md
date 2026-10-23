# API Reference

Complete API documentation for @ixo/oracles-client-sdk.

## Table of Contents

- [Hooks](#hooks)
  - [useChat](#usechat)
  - [useOracleSessions](#useoraclesessions)
  - [useActiveRuns](#useactiveruns)
  - [useAbortSession](#useabortsession)
  - [useWebSocketEvents](#usewebsocketevents)
  - [useContractOracle](#usecontractoracle)
  - [useMemoryEngine](#usememoryengine)
  - [useGetOpenIdToken](#usegetopenidtoken)
  - [useLiveAgent](#useliveagent)
- [Components](#components)
  - [OraclesProvider](#oraclesprovider)
- [Utilities](#utilities)
  - [renderMessageContent](#rendermessagecontent)
  - [getOpenIdToken](#getopenidtoken)
- [Types](#types)

---

## Hooks

### useChat

Main hook for chat functionality with real-time streaming.

#### Signature

```typescript
function useChat(options: IChatOptions): UseChatReturn;
```

#### Parameters

```typescript
interface IChatOptions {
  oracleDid: string; // Oracle DID identifier
  sessionId: string; // Active session ID
  onPaymentRequiredError: (claimIds: string[]) => void; // Payment handler
  browserTools?: IBrowserTools; // Optional browser-side tools
  uiComponents?: Partial<UIComponents>; // Custom UI components
  overrides?: {
    baseUrl?: string; // Override API base URL
    wsUrl?: string; // Override WebSocket URL
  };
  streamingMode?: 'batched' | 'immediate'; // Streaming update behavior
}
```

#### Streaming Modes

The `streamingMode` option controls how updates are batched during streaming:

- **`'immediate'`** (default): Updates are applied immediately as they arrive from the backend, providing true real-time streaming at the cost of more React re-renders.
- **`'batched'`**: Updates are batched using `requestAnimationFrame` for optimal performance. Multiple rapid updates are grouped into single React re-renders (~60fps).

```tsx
// Real-time streaming (default behavior)
const { messages } = useChat({
  oracleDid,
  sessionId,
  streamingMode: 'immediate', // or omit for default
  onPaymentRequiredError: handlePayment,
});

// Batched streaming (optimized for performance)
const { messages } = useChat({
  oracleDid,
  sessionId,
  streamingMode: 'batched',
  onPaymentRequiredError: handlePayment,
});
```

#### Return Value

```typescript
interface UseChatReturn {
  messages: IMessage[]; // Array of chat messages
  sendMessage: (
    message: string,
    metadata?: Record<string, unknown>,
  ) => Promise<void>;
  isSending: boolean; // True while sending/streaming
  isLoading: boolean; // True while loading initial data
  error: Error | null; // Error state
  refetchMessages: () => Promise<void>; // Manually refetch messages
  isRealTimeConnected: boolean; // WebSocket/SSE connection status
  status: ChatStatus; // Current chat status
  sendMessageError: Error | null; // Send message error state
}

type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error';
```

#### Example

```tsx
import { useChat, renderMessageContent } from '@ixo/oracles-client-sdk';

function Chat({ oracleDid, sessionId }) {
  const { messages, sendMessage, isSending, isLoading, error } = useChat({
    oracleDid,
    sessionId,
    onPaymentRequiredError: (claims) => console.log('Pay:', claims),
    uiComponents: {
      WeatherWidget: (props) => <div>{props.temp}°C</div>,
    },
  });

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id}>{renderMessageContent(msg.content)}</div>
      ))}
      <button onClick={() => sendMessage('Hello')} disabled={isSending}>
        Send
      </button>
    </div>
  );
}
```

---

### useOracleSessions

Manage chat sessions with an oracle.

#### Signature

```typescript
function useOracleSessions(
  oracleDid: string,
  overrides?: { baseUrl?: string },
): UseOracleSessionsReturn;
```

#### Return Value

```typescript
interface UseOracleSessionsReturn {
  sessions: IChatSession[] | undefined; // List of sessions
  createSession: () => Promise<IChatSession>; // Create new session
  deleteSession: (sessionId: string) => Promise<void>; // Delete session
  isLoading: boolean; // Loading state
  error: Error | null; // Error state
  refetch: () => Promise<void>; // Refetch sessions
  isCreatingSession: boolean; // Creating session state
  isCreateSessionError: boolean; // Create session error state
  isDeletingSession: boolean; // Deleting session state
  isDeleteSessionError: boolean; // Delete session error state
}

interface IChatSession {
  sessionId: string;
  title: string;
  createdAt: string;
  lastUpdatedAt: string;
  oracleName: string;
  roomId?: string;
  /**
   * The run the session was busy with when the list was fetched; absent
   * when none (and on runtimes that predate it). For a live status use
   * `useActiveRuns`.
   */
  activeRun?: ChatRunSummary;
}
```

#### Example

```tsx
import { useOracleSessions } from '@ixo/oracles-client-sdk';

function SessionManager({ oracleDid }) {
  const { sessions, createSession, deleteSession, isLoading } =
    useOracleSessions(oracleDid);

  return (
    <div>
      <button onClick={() => createSession()}>New Chat</button>
      {sessions?.map((session) => (
        <div key={session.sessionId}>
          <span>{session.sessionId}</span>
          <button onClick={() => deleteSession(session.sessionId)}>
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}
```

---

### useActiveRuns

Which of the user's chats on an oracle are running right now, for a live
status on every row of a chat list (`GET /runs/active`). Runs started from
any client count — the Portal, a Matrix room, a channel such as WhatsApp.
Scheduled task runs are not listed (they are not in the session list
either).

#### Signature

```typescript
function useActiveRuns(
  oracleDid: string,
  overrides?: { baseUrl?: string },
): UseActiveRunsReturn;
```

#### Return Value

```typescript
interface UseActiveRunsReturn {
  runs: ChatRunSummary[]; // Every active run, oldest first
  bySession: Record<string, ChatRunSummary>; // The run each busy session is on
  count: number; // How many chats have an active run
  isSupported: boolean; // False once the runtime answered 404
  isLoading: boolean;
  error: Error | null; // The last poll's failure, if it failed
  refetch: () => Promise<unknown>;
}

interface ChatRunSummary {
  runId: string;
  sessionId: string;
  requestId: string;
  client: 'portal' | 'matrix' | 'channel';
  status: ChatRunStatus; // 'queued' | 'running' | 'recovering' here
  startedAt: string;
  updatedAt: string;
  lastSeq: number;
  messageId?: string;
  waitingFor?: ChatRunWaitingFor; // A parked browser call: the user must open the chat
}

interface ChatRunWaitingFor {
  kind: 'browser' | 'agui'; // A browser tool call or an AG-UI action call
  toolName: string; // The oldest parked call's tool or action
  since: string; // When it was parked (ISO 8601)
}
```

A session can have more than one active run (a running one and messages
sent with `multitask: 'enqueue'` behind it); `bySession` holds the running
or recovering one, else the oldest queued one. The summaries carry no
`partialText`.

#### Polling

- Every 4 s (`ACTIVE_RUNS_BUSY_POLL_MS`) while a run is active, every 30 s
  (`ACTIVE_RUNS_IDLE_POLL_MS`) otherwise and after a failed poll.
- Only while the tab is visible and a wallet is signed in; once more when
  the window regains focus.
- The runtime gives the polls their own per-user rate-limit budget (100
  requests per 60 s on the Companion), apart from the user's messages.
  Mount the hook once per oracle (e.g. in the chat list) and read
  `bySession` in the rows; every mounted instance runs its own timer.
- A poll is a background request (`authedRequest(…, { background: true })`):
  it never mints a delegation, and mints invocations with
  `createInvocation(oracleDid, { background: true })`, which the host must
  answer without user interaction (see
  [Credentials and renewal](../README.md#credentials-and-renewal); the
  Portal's `useCreateUcanInvocation` is the reference host). When the host
  mints nothing (a locked signer: 401 with `code` equal to the exported
  `BACKGROUND_INVOCATION_UNAVAILABLE`,
  nothing sent) or the oracle refuses the credentials (401/403) even after
  a fresh invocation, polling pauses until the window is focused again;
  `isSupported` stays `true` and `error` holds the refusal. A host whose
  `createInvocation` ignores the option still prompts from a poll.
- A runtime that predates the route answers 404 `Run active not found`:
  `isSupported` is `false` and the hook probes again every 10 min
  (`ACTIVE_RUNS_UNSUPPORTED_REPROBE_MS`). Fall back to
  `IChatSession.activeRun` (also absent there) or show no status. Any
  other 404 (a wrong base URL) is an ordinary failed poll.
- A busy chat missing from a loaded `useOracleSessions` list (started in a
  Matrix room, a channel or another tab) refreshes that list once.
- Sending a message with `useChat` refreshes the active runs as soon as
  the message's run has started, so the open chat shows busy at once.
- The runs are those of the chats `useOracleSessions` lists (same room
  rule, scheduled task runs left out). `startedAt` is when the runtime
  recorded the message's run; a queued run's wait is included.

`isActiveRunStatus(status)` is `true` for `queued`, `running` and
`recovering`.

`waitingFor` is set while the run is blocked on a call to the user's
browser that no browser could take: the runtime parks a browser tool or
AG-UI action call of the session when no socket of that session that can
run it is connected — usually because the chat is not open in any tab —
instead of failing it. Opening the chat mounts `useChat`'s socket, which
lets the runtime send the parked call, and the run goes on; the host does
nothing else. A parked call nobody takes fails after the runtime's park
deadline (5 min by default) without having been sent. The field describes
the oldest parked call, is computed for each response (never stored), and
is absent on runtimes that do not park calls. `isWaitingOnUser(run)` is
`true` for an active run with a well-formed `waitingFor` (and narrows the
run so `run.waitingFor` can be read); a malformed one counts as not
waiting, so the run still shows as an ordinary active one. Show such a
chat as needing the user ("Needs you") rather than as working.

#### Example

```tsx
import {
  isWaitingOnUser,
  useAbortSession,
  useActiveRuns,
  useOracleSessions,
} from '@ixo/oracles-client-sdk';

function ChatList({ oracleDid }) {
  const { sessions } = useOracleSessions(oracleDid);
  const { bySession, isSupported } = useActiveRuns(oracleDid);
  const { abortSession, isAborting } = useAbortSession(oracleDid);

  return sessions.map((session) => {
    const run = isSupported ? bySession[session.sessionId] : session.activeRun;
    return (
      <div key={session.sessionId}>
        <span>{session.title}</span>
        {run && (
          <span>
            {isWaitingOnUser(run)
              ? 'Needs you'
              : run.status === 'queued'
                ? 'Waiting'
                : 'Working'}
          </span>
        )}
        {run && (
          <button
            disabled={isAborting}
            onClick={() => abortSession(session.sessionId)}
          >
            Stop
          </button>
        )}
      </div>
    );
  });
}
```

---

### useAbortSession

Stop the current message of any session (`POST /messages/abort`), not
only the mounted chat's (`useChat().abortStream` stops that one).

```typescript
function useAbortSession(
  oracleDid: string,
  overrides?: { baseUrl?: string },
): {
  abortSession: (sessionId: string) => Promise<{ success: boolean }>;
  isAborting: boolean;
  error: Error | null;
};
```

The runtime ends the session's active run (the reply so far is kept),
a message still being admitted and one queued behind a superseded run;
messages sent with `multitask: 'enqueue'` behind it still start.
`success` is `false` when there was nothing to stop. The runtime answers
once the stopped run has ended (at most ~5 s). The session leaves
`useActiveRuns` at once and comes back if the request fails; afterwards
the active runs and the `useOracleSessions` lists (whose rows carry
`activeRun`) are refreshed.

---

### useWebSocketEvents

The session's realtime socket (socket.io): it receives the session's
events and runs the browser tools and AG-UI actions the oracle calls in
the browser. `useChat` mounts one for its session; use the hook directly
only for a socket without a chat, such as a background executor.

```typescript
function useWebSocketEvents(
  config: IWebSocketConfig,
): IUseWebSocketEventsReturn;

interface IWebSocketConfig {
  oracleDid: string;
  sessionId: string;
  handleNewEvent: (event: WebSocketEvent) => void;
  handleInvalidateCache?: () => void;
  browserTools?: IBrowserTools; // Read at each call; may change after connect
  actionTools?: IActionTools;
  executor?: 'foreground' | 'background'; // Default 'foreground'
  overrides?: { baseUrl?: string; wsUrl?: string };
}

interface IUseWebSocketEventsReturn {
  isConnected: boolean;
  error: Error | null;
  connectionStatus: WebSocketConnectionStatus; // 'connecting' | 'connected' | 'disconnected' | 'error'
  lastActivity: string | null;
  isConfigReady: boolean;
  socket: Socket | null;
}
```

The CONNECT carries the user's delegation and invocation, built again for
every reconnect; a refusal of the credentials renews them like any other
request (stage 1, then stage 2; a background socket: stage 1 only, see
below).

#### Executor kinds

- `'foreground'` (default): the socket renders the chat. It receives the
  session's events and runs any browser tool or AG-UI action call of the
  session. Its CONNECT payload is `{ ucanDelegation, invocation? }`.
- `'background'`: the socket only runs calls, for a chat that is running
  but not open. Its CONNECT payload adds `executor: 'background'` and
  `tools: Object.keys(browserTools ?? {})`, read again at every CONNECT
  (socket.io asks for the payload on each reconnect), so tools registered
  since are declared on the next one. The runtime sends it only calls of
  the names it declared (so no AG-UI action calls), and only when the
  session has no foreground socket connected (one that connects later
  takes the next call); it gets none of the session's events. The runtime
  keeps at most 24 declared names, each matching
  `^[A-Za-z0-9_-]{1,64}$` (others are dropped), so declare only tools that
  can run without the chat on screen: read-only, no navigation, nothing
  that depends on the current page. When a background socket connects,
  the runtime sends it every parked call of the session it can run
  (`ChatRunSummary.waitingFor`).
- Changing `executor` reconnects the socket.

Every socket answers each `browser_tool_call` of its session definitely:
the runtime sends a call to one socket only, so a socket without any
browser tools answers a `tool_result` with `result: null` and
`error: 'Tool <name> not found: no browser tools registered'` (a tool
missing from a non-empty registry: `Tool <name> not found`) instead of
leaving the call to end as an unknown outcome.

A background socket runs nothing it did not declare, on any runtime:

- It never listens for `action_call` (AG-UI actions, wallet signing
  among them), whatever `actionTools` holds.
- A `browser_tool_call` whose `toolName` its latest CONNECT did not
  declare is refused with a `tool_result` error
  (`Tool <name> not found: not declared by this background executor`),
  also for a tool registered since (the next CONNECT declares it).
- The runtime echoes the accepted executor in its `connected` event
  (`executor: 'foreground' | 'background'`). Until that echo says
  `'background'` the socket answers no call. When the `connected` event
  lacks it — a runtime that predates executor kinds, which would treat
  the socket as a foreground one and send it the session's events and
  every call — the socket closes at once and is not reconnected:
  `connectionStatus` is `'error'` and `error` carries
  `code: 'BACKGROUND_EXECUTOR_UNSUPPORTED'` (exported as
  `BACKGROUND_EXECUTOR_UNSUPPORTED`), with a message saying the runtime
  does not support background executors.

A background socket never involves the user — no PIN or passkey prompt,
whatever is cached:

- It sends the cached delegation only
  (`getDelegation(oracleDid, { background: true })`) and never mints one.
  With none cached (or one inside the cache's 5 min expiry margin) it
  opens nothing: `connectionStatus` is `'error'` and `error` carries
  `code: 'BACKGROUND_SOCKET_UNAVAILABLE'` (exported as
  `BACKGROUND_SOCKET_UNAVAILABLE`). Mount it again once a delegation is
  cached (any foreground request caches one).
- Every CONNECT reads the invocation with
  `getInvocation(oracleDid, { background: true })`: the cached one, or one
  the host's `createInvocation(oracleDid, { background: true })` mints
  without user interaction. When there is none (the host minted nothing,
  e.g. a locked signer, or the read failed) the CONNECT is not sent — a
  background socket never connects with a bare delegation: the socket is
  closed, `connectionStatus` is `'error'` and `error` carries
  `code: 'BACKGROUND_SOCKET_UNAVAILABLE'`.
- A CONNECT refused for its credentials is renewed with
  `renewOracleAuth(oracleDid, 1, sent, { background: true })` only — stage
  2 mints a delegation and never runs. When stage 1 renews nothing, or the
  CONNECT after it is refused again, the socket stays disconnected with the
  refusal as its `error`; mount it again (e.g. after the next successful
  foreground request) to retry.

This relies on the host's `createInvocation` honouring
`{ background: true }`, as for `useActiveRuns` (see
[Credentials and renewal](../README.md#credentials-and-renewal)); a host
that ignores the option still prompts from a background mint.

---

### useContractOracle

Handle oracle payments, authorization, and room management.

#### Signature

```typescript
function useContractOracle({
  params,
}: IUseContractOracleProps): UseContractOracleReturn;
```

#### Parameters

```typescript
interface IUseContractOracleProps {
  params: {
    oracleDid: string;
    userClaimCollectionId: string;
    adminAddress: string;
    claimId: string;
    agentQuota?: number;
    maxAmount?: {
      amount: number;
      denom: string;
    };
  };
}
```

#### Return Value

```typescript
interface UseContractOracleReturn {
  contractOracle: (options: { useAuthz?: boolean }) => Promise<void>;
  isContractingOracle: boolean;
  payClaim: () => Promise<void>;
  isPayingClaim: boolean;
  isLoadingPricingList: boolean;
  pricingList: any[] | undefined;
  isLoadingAuthzConfig: boolean;
  authzConfig: any | undefined;
  isOracleInRoom: boolean | undefined;
  isLoadingOracleInRoom: boolean;
  inviteOracle: () => Promise<void>;
  isInvitingOracle: boolean;
}
```

#### Example

```tsx
import { useContractOracle } from '@ixo/oracles-client-sdk';

function PaymentHandler({
  oracleDid,
  userClaimCollectionId,
  adminAddress,
  claimId,
}) {
  const {
    contractOracle,
    isContractingOracle,
    payClaim,
    isPayingClaim,
    isOracleInRoom,
    inviteOracle,
    isInvitingOracle,
  } = useContractOracle({
    params: {
      oracleDid,
      userClaimCollectionId,
      adminAddress,
      claimId,
      agentQuota: 1,
    },
  });

  const handleContractOracle = async () => {
    try {
      await contractOracle({ useAuthz: true });
      console.log('Oracle contracted successfully');
    } catch (error) {
      console.error('Failed to contract oracle:', error);
    }
  };

  const handlePayClaim = async () => {
    try {
      await payClaim();
      console.log('Claim paid successfully');
    } catch (error) {
      console.error('Failed to pay claim:', error);
    }
  };

  return (
    <div>
      {!isOracleInRoom && (
        <button onClick={inviteOracle} disabled={isInvitingOracle}>
          {isInvitingOracle ? 'Inviting Oracle...' : 'Invite Oracle to Room'}
        </button>
      )}

      <button onClick={handleContractOracle} disabled={isContractingOracle}>
        {isContractingOracle ? 'Contracting...' : 'Contract Oracle'}
      </button>

      <button onClick={handlePayClaim} disabled={isPayingClaim}>
        {isPayingClaim ? 'Paying...' : 'Pay Claim'}
      </button>
    </div>
  );
}
```

---

### useMemoryEngine

Manage Matrix room members and memory engine permissions for an oracle.

#### Signature

```typescript
function useMemoryEngine(oracleDid: string): UseMemoryEngineReturn;
```

#### Parameters

- `oracleDid` (string): The DID of the oracle to manage memory engine for

#### Return Value

```typescript
interface UseMemoryEngineReturn {
  inviteUser: (userId: string) => Promise<void>;
  isInvitingUser: boolean;
  isLoadingOracleRoomId: boolean;
  oracleRoomId: string | undefined;
  isLoadingMembers: boolean;
  members: any[] | undefined;
  enableMemoryEngine: (memoryEngineUserId: string) => Promise<void>;
  isLoadingMemoryEngine: boolean;
}
```

#### Usage

```typescript
import { useMemoryEngine } from '@ixo/oracles-client-sdk';

function OracleManagement({ oracleDid }: { oracleDid: string }) {
  const {
    inviteUser,
    isInvitingUser,
    oracleRoomId,
    members,
    enableMemoryEngine,
    isLoadingMemoryEngine,
  } = useMemoryEngine(oracleDid);

  const handleInviteUser = async (userId: string) => {
    try {
      await inviteUser(userId);
      console.log('User invited successfully');
    } catch (error) {
      console.error('Failed to invite user:', error);
    }
  };

  const handleEnableMemoryEngine = async (memoryEngineUserId: string) => {
    try {
      await enableMemoryEngine(memoryEngineUserId);
      console.log('Memory engine enabled');
    } catch (error) {
      console.error('Failed to enable memory engine:', error);
    }
  };

  return (
    <div>
      <h3>Oracle Room: {oracleRoomId}</h3>
      <div>
        <h4>Members ({members?.length || 0})</h4>
        {members?.map((member, index) => (
          <div key={index}>{member.userId}</div>
        ))}
      </div>

      <button
        onClick={() => handleInviteUser('@user:matrix.org')}
        disabled={isInvitingUser}
      >
        {isInvitingUser ? 'Inviting...' : 'Invite User'}
      </button>

      <button
        onClick={() => handleEnableMemoryEngine('@memory-engine:matrix.org')}
        disabled={isLoadingMemoryEngine}
      >
        {isLoadingMemoryEngine ? 'Enabling...' : 'Enable Memory Engine'}
      </button>
    </div>
  );
}
```

#### What it does

- **Room Management**: Gets the Matrix room ID for the oracle
- **Member Management**: Lists room members and invites new users
- **Memory Engine Setup**: Enables memory engine by inviting the memory engine user and setting appropriate power levels
- **Authorization**: Uses wallet context for Matrix authentication

---

### useGetOpenIdToken

Get the current OpenID token for authentication.

#### Signature

```typescript
function useGetOpenIdToken(forceNewToken?: boolean): UseGetOpenIdTokenReturn;
```

#### Return Value

```typescript
interface UseGetOpenIdTokenReturn {
  openIdToken: IOpenIDToken | undefined;
  isLoading: boolean;
  error: Error | null;
}

interface IOpenIDToken {
  access_token: string;
  expires_in: number;
  matrix_server_name: string;
  token_type: string;
}
```

#### Example

```tsx
import { useGetOpenIdToken } from '@ixo/oracles-client-sdk';

function AuthStatus() {
  const { openIdToken, isLoading } = useGetOpenIdToken();

  if (isLoading) return <div>Authenticating...</div>;
  if (!openIdToken) return <div>Not authenticated</div>;

  return <div>✓ Authenticated</div>;
}
```

---

### useAgAction

Register AG-UI actions that the AI oracle can invoke to generate dynamic user interfaces.

#### Signature

```typescript
function useAgAction<TSchema extends z.ZodTypeAny>(
  config: AgActionConfig<TSchema>,
): void;
```

#### Parameters

```typescript
interface AgActionConfig<TSchema extends z.ZodTypeAny> {
  name: string;
  description: string;
  parameters: TSchema;
  handler: (args: z.infer<TSchema>) => Promise<any> | any;
  render?: (props: {
    status?: 'isRunning' | 'done' | 'error';
    args?: z.infer<TSchema>;
    result?: any;
    isLoading?: boolean;
  }) => React.ReactElement | null;
}
```

| Parameter     | Type        | Required | Description                                                             |
| ------------- | ----------- | -------- | ----------------------------------------------------------------------- |
| `name`        | `string`    | Yes      | Unique identifier for the action                                        |
| `description` | `string`    | Yes      | Description visible to the AI (include schema hints for better results) |
| `parameters`  | `ZodSchema` | Yes      | Zod schema for automatic validation                                     |
| `handler`     | `function`  | Yes      | Async function that executes the action logic                           |
| `render`      | `function`  | No       | Optional React component renderer for custom UI                         |

#### Type Definitions

```typescript
// Registered action metadata
export interface AgAction {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  hasRender: boolean;
}
```

#### Basic Example

```typescript
import { useAgAction } from '@ixo/oracles-client-sdk';
import { z } from 'zod';

const createDataTableSchema = z.object({
  title: z.string().optional().describe('Table title'),
  columns: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.enum(['string', 'number', 'boolean']).optional(),
    })
  ),
  data: z.array(z.record(z.any())),
});

function ChatInterface() {
  useAgAction({
    name: 'create_data_table',
    description: 'Create a data table with columns and rows',
    parameters: createDataTableSchema,

    handler: async (args) => {
      // TypeScript knows the exact shape of args!
      console.log('Creating table with', args.data.length, 'rows');
      return { success: true, rowCount: args.data.length };
    },

    render: ({ status, args }) => {
      if (status === 'done' && args) {
        return <DataTable {...args} />;
      }
      return null;
    },
  });

  // ... rest of chat interface
}
```

#### Advanced Example: Multi-Operation Dashboard

```typescript
const manageDashboardSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('create'),
    components: z.array(componentSchema),
  }),
  z.object({
    operation: z.literal('update_layout'),
    changes: z.array(z.object({ id: z.string(), position: positionSchema })),
  }),
  z.object({
    operation: z.literal('add_component'),
    component: componentSchema,
  }),
  z.object({
    operation: z.literal('remove_component'),
    componentId: z.string(),
  }),
]);

function ChatInterface() {
  const dashboardStateRef = useRef<DashboardState>({
    layout: { type: 'grid', columns: 12, gap: 'md' },
    components: new Map(),
  });

  useAgAction({
    name: 'manage_dashboard',
    description:
      'Create and manage multi-component dashboards with operations: ' +
      'create, update_layout, add_component, remove_component',
    parameters: manageDashboardSchema,

    handler: async (args) => {
      const currentState = dashboardStateRef.current;

      switch (args.operation) {
        case 'create':
          // Create new dashboard
          dashboardStateRef.current = {
            layout: currentState.layout,
            components: new Map(
              args.components.map(c => [c.id, c])
            ),
          };
          return { success: true, operation: 'create' };

        case 'add_component':
          // Add component to existing dashboard
          currentState.components.set(args.component.id, args.component);
          return { success: true, operation: 'add_component' };

        // ... other operations
      }
    },

    render: ({ status }) => {
      if (status === 'done') {
        return <DashboardCanvas state={dashboardStateRef.current} />;
      }
      return null;
    },
  });
}
```

#### Integration

AG-UI actions integrate seamlessly with the `OraclesProvider` context:

1. **Registration** - Actions are registered on component mount
2. **Discovery** - AI oracle receives list of available actions
3. **Validation** - SDK automatically validates arguments against Zod schema
4. **Execution** - Handler runs with validated, type-safe arguments
5. **Rendering** - Optional render function creates UI when action completes
6. **Cleanup** - Actions are unregistered on component unmount

#### Lifecycle

```typescript
// Mount → Register
useEffect(() => {
  registerAgAction(action, handler, render);
  return () => unregisterAgAction(action.name);
}, [action.name]);

// AI Invocation → Validation → Handler → Render
1. AI calls action with arguments
2. SDK validates args against schema
3. Handler executes if valid
4. Render function called with status='done'
5. Result displayed in chat
```

#### Error Handling

The SDK provides automatic schema validation with detailed error messages:

```typescript
// If validation fails
{
  error: "Schema validation failed for action 'create_table'. " +
    'columns: Required. ' +
    'data: Expected array, received string. ' +
    'Required format: { full JSON schema }';
}
```

Throw errors in your handler for business logic failures:

```typescript
handler: async (args) => {
  if (args.data.length === 0) {
    throw new Error('Cannot create table with empty data');
  }
  return { success: true };
};
```

#### See Also

- [AG-UI Tools Guide](./AG_UI_TOOLS.md) - Complete guide with examples
- [Usage Guide](./USAGE_GUIDE.md#ag-ui-actions) - Getting started

---

### useLiveAgent

Enable voice and video calls with AI agents.

**Note:** This hook is in a separate bundle to keep your main bundle small. Import it separately:

```typescript
import { useLiveAgent } from '@ixo/oracles-client-sdk/live-agent';
```

#### Signature

```typescript
function useLiveAgent(
  oracleDid: string,
  mxClient: MatrixClient,
  openIdToken: IOpenIDToken,
  toastAlert?: ToastFn,
  overrides?: { baseUrl?: string },
): UseLiveAgentReturn;
```

#### Return Value

```typescript
interface UseLiveAgentReturn {
  callAgent: (options: CallOptions) => Promise<void>;
  endCall: () => Promise<void>;
  isCalling: boolean;
  sessionStarted: boolean;
  sessionViewVisible: boolean;
  isConnecting: boolean;
  room: Room; // LiveKit room instance
}

interface CallOptions {
  callType: 'audio' | 'video';
  sessionId: string;
  userDid: string;
  agentVoice: VoiceName;
  language: LanguageCode;
}
```

See [Live Agent Guide](./LIVE_AGENT.md) for complete documentation.

---

## Components

### OraclesProvider

Required context provider that wraps your application.

#### Props

```typescript
interface OraclesProviderProps {
  initialWallet: IWalletProps; // User's wallet
  transactSignX: TransactionFn; // Transaction signing function
  createDelegation: (oracleDid: string) => Promise<DelegationResult>;
  // `{ background: true }`: mint without any user interaction (no prompt,
  // no signer idle-timer extension) or resolve null. See the README's
  // "Credentials and renewal".
  createInvocation?: (
    oracleDid: string,
    options?: { background?: boolean },
  ) => Promise<InvocationResult | null>;
  children: ReactNode;
}

interface IWalletProps {
  address: string; // Blockchain address
  did: string; // DID identifier
  matrix: {
    accessToken: string; // Matrix access token
  };
}
```

#### Example

```tsx
import { OraclesProvider } from '@ixo/oracles-client-sdk';

function App() {
  return (
    <OraclesProvider
      initialWallet={{
        address: 'ixo1...',
        did: 'did:ixo:entity:...',
        matrix: { accessToken: 'syt_...' },
      }}
      transactSignX={async (messages, memo) => {
        // Sign and broadcast transaction
        return await signAndBroadcast(messages, memo);
      }}
    >
      <YourApp />
    </OraclesProvider>
  );
}
```

---

## Utilities

### renderMessageContent

Transform message content (metadata) into React elements.

#### Signature

```typescript
function renderMessageContent(
  content: MessageContent,
  uiComponents?: Partial<UIComponents>,
): ReactNode;
```

#### Parameters

```typescript
type MessageContent =
  | string
  | IComponentMetadata
  | Array<string | IComponentMetadata>;

interface IComponentMetadata {
  name: string; // Component name
  props: {
    id: string;
    args: unknown;
    status?: 'isRunning' | 'done';
    output?: string;
    [key: string]: any;
  };
}
```

#### Example

```tsx
import { renderMessageContent } from '@ixo/oracles-client-sdk';

const uiComponents = {
  WeatherWidget: (props) => (
    <div>
      {props.city}: {props.temp}°C
    </div>
  ),
};

function MessageList({ messages }) {
  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id}>
          {renderMessageContent(msg.content, uiComponents)}
        </div>
      ))}
    </div>
  );
}
```

---

### getOpenIdToken

Manually retrieve an OpenID token from Matrix.

#### Signature

```typescript
function getOpenIdToken(params: GetOpenIdTokenParams): Promise<IOpenIDToken>;
```

#### Parameters

```typescript
interface GetOpenIdTokenParams {
  userId: string; // Matrix user ID
  matrixAccessToken: string; // Matrix access token
}
```

#### Example

```typescript
import { getOpenIdToken } from '@ixo/oracles-client-sdk';

const token = await getOpenIdToken({
  userId: '@did-ixo-ixo1k7n56esve8zel2prlp40h4gsvg9dr5jje5druh:devmx.ixo.earth',
  matrixAccessToken: 'syt_...',
});
console.log('Access token:', token.access_token);
```

---

## Types

### Core Types

```typescript
// Message structure
interface IMessage {
  id: string;
  content: MessageContent;
  type: 'ai' | 'human';
  chunks?: number;
  toolCalls?: Array<{
    name: string;
    id: string;
    args: unknown;
    status?: 'isRunning' | 'done' | 'error';
    output?: string;
    error?: string;
  }>;
}

// Message content types
type MessageContent =
  | string
  | IComponentMetadata
  | Array<string | IComponentMetadata>;

// Component metadata
interface IComponentMetadata {
  name: string;
  props: {
    id: string;
    args: unknown;
    status?: 'isRunning' | 'done' | 'error';
    output?: string;
    error?: string;
    event?: any;
    payload?: any;
    isToolCall?: boolean;
    isAgAction?: boolean;
  };
}

// Session info
interface IChatSession {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

// Chat status
type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error';
```

### AG-UI Action Types

```typescript
// AG-UI action configuration
interface AgActionConfig<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  parameters: TSchema;
  handler: (args: z.infer<TSchema>) => Promise<any> | any;
  render?: (props: {
    status?: 'isRunning' | 'done' | 'error';
    args?: z.infer<TSchema>;
    result?: any;
    isLoading?: boolean;
  }) => React.ReactElement | null;
}

// Registered AG action metadata
interface AgAction {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  hasRender: boolean;
}

// Handler function type
type AgActionHandler<T = any> = (args: T) => Promise<any> | any;

// Render function type
type AgActionRender<T = any> = (props: {
  status?: 'isRunning' | 'done' | 'error';
  args?: T;
  result?: any;
  isLoading?: boolean;
}) => React.ReactElement | null;
```

### Event Types

```typescript
// Tool call event
interface ToolCallEvent {
  eventName: 'tool_call';
  payload: ToolCallEventPayload;
}

// Render component event
interface RenderComponentEvent {
  eventName: 'render_component';
  payload: RenderComponentEventPayload;
}

// Browser tool call event
interface BrowserToolCallEvent {
  eventName: 'browser_tool_call';
  payload: BrowserToolCallEventPayload;
}

// Union type
type AnyEvent = ToolCallEvent | RenderComponentEvent | BrowserToolCallEvent;
```

### UI Component Props

```typescript
// Base props for all UI components
interface UIComponentProps<Ev extends AnyEvent> {
  id: string;
  isLoading?: boolean;
  output?: string;
  // Event-specific props are merged in
}
```

---

## Error Handling

### RequestError

Custom error class for API requests:

```typescript
class RequestError extends Error {
  constructor(message: string, data?: any);

  static isRequestError(error: unknown): error is RequestError;

  claims?: string[];
  outstandingClaims?: string[];
}
```

#### Example

```typescript
try {
  await sendMessage('Hello');
} catch (error) {
  if (RequestError.isRequestError(error) && error.claims) {
    console.log('Payment required:', error.claims);
  }
}
```

---

## Advanced Usage

### Custom Browser Tools

Define tools that run in the browser:

```typescript
import { z } from 'zod';

const browserTools = {
  getCurrentLocation: {
    toolName: 'getCurrentLocation',
    description: "Get the user's current location",
    schema: z.object({}),
    effect: 'read', // optional: 'read' | 'write'
    fn: async () => {
      return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition((position) => {
          resolve({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          });
        });
      });
    },
  },
};

const { sendMessage } = useChat({
  oracleDid,
  sessionId,
  browserTools, // Pass browser tools
  onPaymentRequiredError: () => {},
});
```

`effect` (optional) tells the oracle what the tool does, and is sent with
its declaration. `read` only looks: if the oracle restarts while the call
is out, it may run the call again. `write` changes something: after a
restart that leaves its outcome unknown it is not repeated blindly. Leave
it out and the oracle classifies the tool by its name (`get…`, `list…`,
`find…`, `get_…` and the like are reads; any other name is a write). The
oracle treats its human-decision tools (`ask_user_question`,
`propose_domain_creation`, `write_domain_files`, `publish_recipe_release`)
as writes whatever is declared. A call the oracle never managed to send to
a browser is always issued again after a restart, whatever its effect.

### Overriding API URLs

For testing or custom deployments:

```typescript
const { messages } = useChat({
  oracleDid,
  sessionId,
  overrides: {
    baseUrl: 'https://custom-api.example.com',
    wsUrl: 'wss://custom-ws.example.com',
  },
  onPaymentRequiredError: () => {},
});
```

---

## TypeScript Tips

### Importing Types

```typescript
import type {
  IMessage,
  MessageContent,
  IComponentMetadata,
  IChatSession,
  ChatStatus,
  UIComponentProps,
  AnyEvent,
} from '@ixo/oracles-client-sdk';
```

### Typing Custom Components

```typescript
import type { UIComponentProps, ToolCallEvent } from '@ixo/oracles-client-sdk';

type WeatherProps = UIComponentProps<ToolCallEvent> & {
  city: string;
  temperature: number;
};

function WeatherWidget({ city, temperature, isLoading }: WeatherProps) {
  return <div>{isLoading ? 'Loading...' : `${city}: ${temperature}°C`}</div>;
}
```

---

## Next Steps

- [Usage Guide](./USAGE_GUIDE.md) - Complete usage documentation
