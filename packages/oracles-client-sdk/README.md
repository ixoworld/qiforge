# @ixo/oracles-client-sdk

> Production-ready React SDK for building AI-powered applications with QiForge

[![npm version](https://badge.fury.io/js/%40ixo%2Foracles-client-sdk.svg)](https://www.npmjs.com/package/@ixo/oracles-client-sdk)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

## Features

- **Real-time Streaming** - AI responses with optimized streaming
- **Chat Management** - Complete session and message management
- **Custom UI Components** - Extensible component system for rich interactions
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
        matrix: { accessToken: 'syt_...' },
      }}
      transactSignX={async (messages, memo) => {
        // Handle blockchain transactions
        return undefined;
      }}
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

- `useChat` - Real-time chat with streaming
- `useOracleSessions` - Session management
- `useContractOracle` - Payment and authorization
- `useMemoryEngine` - Matrix room management and memory engine setup
- `useLiveAgent` - Voice/video calls (separate bundle)

### Components

- `OraclesProvider` - Required context provider
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
