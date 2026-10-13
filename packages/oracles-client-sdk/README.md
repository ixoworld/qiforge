# @ixo/oracles-client-sdk

> Production-ready React SDK for building AI-powered applications with QiForge

[![npm version](https://badge.fury.io/js/%40ixo%2Foracles-client-sdk.svg)](https://www.npmjs.com/package/@ixo/oracles-client-sdk)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

## Features

- **Real-time Streaming** - AI responses with optimized streaming
- **Chat Management** - Complete session and message management
- **Custom UI Components** - Extensible component system for rich interactions
- **AG-UI Actions & Browser Tools** - Actions and tools the oracle runs in the user's browser, scoped to one session and socket
- **Voice & Video Calls** - Encrypted live agent calls
- **Memory Engine** - Optional persistent context across sessions
- **Payment Integration** - Built-in oracle payment handling
- **Type Safe** - Full TypeScript support with comprehensive types

## Installation

```bash
npm install @ixo/oracles-client-sdk
# or
pnpm add @ixo/oracles-client-sdk
# or
yarn add @ixo/oracles-client-sdk
```

## Quick Start

```tsx
import {
  OraclesProvider,
  useChat,
  useOracleSessions,
  renderMessageContent,
} from '@ixo/oracles-client-sdk';

function App() {
  return (
    <OraclesProvider
      initialWallet={{
        address: 'ixo1...',
        did: 'did:ixo:entity:...',
        matrix: { accessToken: 'syt_...', homeServer: 'https://...' },
      }}
      transactSignX={async (messages, memo) => {
        // Handle blockchain transactions
        return undefined;
      }}
      // The user's UCAN delegation to the oracle, and an invocation proved
      // by it: { serialized, expiresAt }
      createDelegation={(oracleDid) => myWallet.delegateTo(oracleDid)}
      createInvocation={(oracleDid) => myWallet.invoke(oracleDid)}
    >
      <ChatInterface />
    </OraclesProvider>
  );
}

function ChatInterface() {
  const oracleDid = 'did:ixo:entity:oracle-id';

  // Create or get session
  const { createSession, sessions } = useOracleSessions(oracleDid);
  const sessionId = sessions?.[0]?.sessionId;

  // Chat functionality
  const { messages, sendMessage, isSending } = useChat({
    oracleDid,
    sessionId: sessionId || '',
    onPaymentRequiredError: (claimIds) => {
      console.log('Payment required:', claimIds);
    },
  });

  return (
    <div className="chat-container">
      {/* Create session button */}
      <button onClick={() => createSession()}>New Chat</button>

      {/* Messages */}
      <div className="messages">
        {messages.map((msg) => (
          <div key={msg.id} className={msg.type}>
            {/* Render message content (handles text and components) */}
            {renderMessageContent(msg.content)}
          </div>
        ))}
      </div>

      {/* Input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.message;
          sendMessage(input.value);
          input.value = '';
        }}
      >
        <input name="message" placeholder="Ask anything..." />
        <button type="submit" disabled={isSending}>
          {isSending ? 'Sending...' : 'Send'}
        </button>
      </form>
    </div>
  );
}
```

`myWallet` stands for the host app's own UCAN signing. `createInvocation` is optional in the type, but the Workers runtime (`@ixo/oracle-runtime-workers`) authenticates a request only by its invocation (`Authorization: Bearer <invocation>`); a request carrying only the delegation gets 401 unless the oracle sets `UCAN_ALLOW_BARE_DELEGATION_AUTH=true`. The delegation must have an expiry.

### Credentials and renewal

Every request to an oracle carries two UCANs, both cached per user and oracle in `localStorage` and minted on demand (callers that miss the cache at the same moment share one mint):

- the **delegation** (`x-ucan-delegation`): the user's grant to the oracle, long-lived. The oracle keeps the newest one it sees and mints its own downstream invocations from it. Minting one needs the user's key (a PIN or passkey on the Portal).
- the **invocation** (`Authorization: Bearer …`): short-lived (minutes), it proves who is calling.

When the oracle refuses a request for its credentials (401, or a 403 other than `VFS_AUTH_FAILED`), the SDK renews them in two stages and repeats the request after each:

1. a fresh **invocation**;
2. only if the request is refused again: a fresh **delegation**, then a fresh invocation.

Still refused after stage 2, it gives up. Stage 2 never runs on a first refusal or when stage 1 got through, so the user is asked for their key only when the delegation itself is the problem. A delegation that stage 2 minted less than ten minutes ago is not replaced by another stage 2 (a refusal that soon is not fixed by asking again). Refusals that arrive together (several requests, the socket, a re-join) share one renewal, and a caller whose refused credentials were already replaced by another caller's renewal just repeats with the new ones. The runtime authenticates before a request reaches the user's data, so a refused request was never processed and repeating it is safe.

This applies to `authedRequest` (every hook's REST calls), the turn's `POST /messages/:sessionId` (repeated only while it is refused; once accepted it is never sent again), every re-join of a running reply, and the realtime socket's CONNECT (a refusal of the credentials themselves; a failed session check is final).

- `run.ended === 'unauthorized'` (`useChat`): a re-join of the running reply was refused after both stages (or for a reason new credentials cannot fix). The reply itself goes on and appears in the transcript once the conversation reloads. A message whose POST is still refused after both stages was not sent: `sendMessage` rejects with the refusal (`status` 401/403).
- `useOraclesContext().renewOracleAuth(oracleDid, stage, refused?)` is the same renewal for a host's own requests: call stage 1 after a refusal and repeat, stage 2 only after the repeat was refused too, passing the credentials the refused request carried. It resolves `false` when there is nothing to repeat with. `getDelegation(oracleDid, { fresh: true })` and `getInvocation(oracleDid, { fresh: true })` mint without the staging.
- `onDelegationRenewed(oracleDid, delegation)` (provider prop, optional) runs after stage 2 minted a delegation. The oracle already adopts the new delegation from the repeated request; use the hook to update anything else that holds the old one, such as a delegation deposited with `POST /delegation` (the oracle reads that copy for Matrix turns when it has none of its own).

## 📚 Documentation

- **[Usage Guide](./docs/USAGE_GUIDE.md)** - Complete walkthrough with examples
- **[API Reference](./docs/API_REFERENCE.md)** - Full API documentation
- **[Tool Calls & Browser Tools](./docs/TOOL_CALLS.md)** - Tool calls and browser-side tools
- **[Examples](./docs/EXAMPLES.md)** - Practical code examples
- **[Live Agent](./docs/LIVE_AGENT.md)** - Voice & video calls guide

## Key Concepts

### Message Rendering

The SDK stores messages as **plain data** (not React elements) for optimal performance. Use `renderMessageContent` to transform messages into UI:

```tsx
import { renderMessageContent } from '@ixo/oracles-client-sdk';

// Handles strings, custom components, and mixed content
{
  messages.map((msg) => (
    <div key={msg.id}>{renderMessageContent(msg.content, uiComponents)}</div>
  ));
}
```

### Custom UI Components

Register custom components for rich interactions:

```tsx
const uiComponents = {
  WeatherWidget: (props) => (
    <div>
      <h3>Weather in {props.city}</h3>
      <p>{props.temperature}°C</p>
    </div>
  ),
  PriceChart: (props) => <Chart data={props.data} />,
};

const { messages } = useChat({
  oracleDid,
  sessionId,
  uiComponents, // Pass to useChat
  onPaymentRequiredError: () => {},
});
```

### History paging and render throttling

`useChat` loads a session's history one page of turns at a time (newest
first) and exposes `hasEarlier`, `loadEarlier()` and `isLoadingEarlier` for
a "load earlier messages" affordance; after a turn only what the turn added
is fetched. Against a runtime without the paged route the whole transcript
loads as one page, so nothing changes for older oracles. Pass
`streamingMode: 'throttled'` (window `streamingThrottleMs`, default 50 ms)
to render at most a few times a second while a reply streams — the default
`immediate` renders on every chunk. `historyPageSize` (default 20) sets the
page.

### Anonymous response feedback

When the runtime advertises it (`capabilities.anonymousMessageFeedback` on
the transcript), `isAnonymousMessageFeedbackSupported` is true and
`submitMessageFeedback(messageId, { submissionId, feedback, context })` sends
anonymous feedback about one completed Agent reply. Generate `submissionId`
(a UUID v4) once per submission and reuse it on retry; `context` is the
allowlisted `AnonymousMessageFeedbackContext` (surface, locale, theme, device
class, viewport bucket, network, optional Portal build). A refusal is a
`RequestError` whose `code` (`AnonymousMessageFeedbackErrorCode`) and
`retryable` say what happened: `FEEDBACK_CONTAINS_PERSONAL_DATA` (422, the
text holds an identifier or secret), `FEEDBACK_ALREADY_SUBMITTED` (409, one
feedback per reply), and the retryable `FEEDBACK_IN_FLIGHT` (409, this
submission is still being delivered), `FEEDBACK_RATE_LIMITED` (429) and
`FEEDBACK_DELIVERY_FAILED` (502) — retry those with the same
`submissionId`. `submittingFeedbackMessageId` and
`messageFeedbackError` track the request; the message list is never changed
or refetched. Against older runtimes the flag is false and the call throws
before sending anything. The `RequestError` class itself is not exported;
read `code` and `retryable` from the thrown error.

### AG-UI actions and browser tools

`useAgAction({ name, description, parameters, handler, render?, exposeToAgent? })`
registers an action the oracle can call in the user's browser. Actions are
sent with each turn as `agActions`, so the model can call them. With
`exposeToAgent: false` the action is registered and answered over the socket
but not sent with the turn: the model never sees it, and the oracle reaches it
only from one of its own tools (the Portal wallet-signing action of
`@ixo/ixo-transaction/react` works this way). `useOraclesContext()` exposes
`agActions` (the ones offered to the agent) and `registeredAgActions` (every
registered action).

Socket calls are scoped to one session and one connection: a
`browser_tool_call` or `action_call` runs only when it names the hook's
current session on the current connection, an `action_call` only while its
status is `isRunning`, and browser tools registered after the socket
connected are honoured. This matches version 2 of the runtime's
[frontend bridge](../oracle-runtime-workers/docs/frontend-bridge.md), where a
call that gets no answer resolves as an unknown outcome instead of a failure.

### Real-time Streaming

Messages stream in real-time with optimized performance:

- **RAF Batching**: Uses `requestAnimationFrame` to batch multiple rapid updates into single render cycles, preventing UI stuttering during high-frequency streaming
- **Efficient State Updates**: Shallow copies only (no expensive deep cloning)
- **Smooth Performance**: Maintains 60fps streaming even at 100+ chunks/sec
- **Memory Optimized**: Metadata-based component storage reduces memory footprint

### Voice & Video (Optional)

Live agent calls are **lazy loaded** to keep your bundle small:

```tsx
// Import separately to avoid loading ~500KB unless needed
import { useLiveAgent } from '@ixo/oracles-client-sdk/live-agent';
```

## 🛠️ Core APIs

### Hooks

- `useChat` - Real-time chat with streaming, history paging, anonymous feedback
- `useOracleSessions` - Session management
- `useAgAction` - Register an AG-UI action (`exposeToAgent` hides it from the model)
- `useModels` - The oracle's model catalog (for a model picker)
- `useOraclesConfig` - The oracle's entity document and authz config, read from the chain
- `useContractOracle` - Payment and authorization
- `useMemoryEngine` - Matrix room management and memory engine setup
- `useGetOpenIdToken` / `getOpenIdToken` - Matrix OpenID token
- `useLiveAgent` - Voice/video calls (separate bundle)

### Components

- `OraclesProvider` - Required context provider
- `useOraclesContext` - The provider's context (wallet, `authedRequest`, `getDelegation`, `getInvocation`, `renewOracleAuth`, `agActions`, `registeredAgActions`)
- `renderMessageContent` - Message renderer utility

### Types

- `IMessage` - Message structure
- `MessageContent` - Content types (string | metadata | array)
- `IComponentMetadata` - Custom component metadata
- `IChatSession` - Session info

## TypeScript Support

Fully typed with comprehensive interfaces:

```typescript
import type {
  IMessage,
  MessageContent,
  IChatSession,
  UIComponentProps,
} from '@ixo/oracles-client-sdk';
```

## 📄 License

Licensed under the terms specified in [License.txt](../../License.txt)

## 🔗 Links

- [IXO Website](https://www.ixo.world/)
- [Documentation](./docs/)
- [Examples](./docs/EXAMPLES.md)
- [GitHub Repository](https://github.com/ixoworld/qiforge)

---

Built with ❤️ by the IXO team
