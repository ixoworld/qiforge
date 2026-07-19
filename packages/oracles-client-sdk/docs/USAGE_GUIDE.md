# Usage Guide

Complete guide to building AI-powered applications with the QiForge Client SDK.

## Table of Contents

- [Installation](#installation)
- [Setup](#setup)
- [Authentication](#authentication)
- [Chat Basics](#chat-basics)
- [Rendering Messages](#rendering-messages)
- [Custom UI Components](#custom-ui-components)
- [Streaming](#streaming)
- [Error Handling](#error-handling)
- [Best Practices](#best-practices)

## Installation

Install the SDK using your preferred package manager:

```bash
npm install @ixo/oracles-client-sdk
# or
pnpm add @ixo/oracles-client-sdk
# or
yarn add @ixo/oracles-client-sdk
```

### Peer Dependencies

The SDK requires React 18+:

```bash
npm install react@^18.0.0
```

## Setup

### 1. Wrap Your App with OraclesProvider

The `OraclesProvider` provides context for all oracle operations:

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
        // Sign blockchain transactions here
        // Return transaction result or undefined
        return undefined;
      }}
    >
      <YourApp />
    </OraclesProvider>
  );
}
```

### 2. Configuration Options

| Option          | Type       | Required | Description                  |
| --------------- | ---------- | -------- | ---------------------------- |
| `initialWallet` | `IWallet`  | Yes      | User's wallet information    |
| `transactSignX` | `function` | Yes      | Transaction signing function |

## Authentication

The SDK handles authentication automatically using Matrix access tokens.

### Getting OpenID Token

```tsx
import { useGetOpenIdToken } from '@ixo/oracles-client-sdk';

function Component() {
  const { openIdToken, isLoading } = useGetOpenIdToken();

  if (isLoading) return <div>Authenticating...</div>;
  if (!openIdToken) return <div>Authentication failed</div>;

  return <div>Authenticated!</div>;
}
```

### Manual Token Retrieval

```tsx
import { getOpenIdToken } from '@ixo/oracles-client-sdk';

const token = await getOpenIdToken(matrixClient);
```

## Chat Basics

### Creating and Managing Sessions

Sessions represent individual conversations with an oracle:

```tsx
import { useOracleSessions } from '@ixo/oracles-client-sdk';

function ChatApp() {
  const oracleDid = 'did:ixo:entity:your-oracle';

  const { sessions, createSession, deleteSession, isLoading } =
    useOracleSessions(oracleDid);

  const handleNewChat = async () => {
    const newSession = await createSession();
    console.log('Created session:', newSession.sessionId);
  };

  return (
    <div>
      <button onClick={handleNewChat}>New Chat</button>

      {sessions?.map((session) => (
        <div key={session.sessionId}>
          <p>Session: {session.sessionId}</p>
          <button onClick={() => deleteSession(session.sessionId)}>
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}
```

### Using the Chat Hook

The `useChat` hook provides complete chat functionality:

```tsx
import { useChat, renderMessageContent } from '@ixo/oracles-client-sdk';

function Chat({ oracleDid, sessionId }) {
  const {
    messages, // Array of messages
    sendMessage, // Function to send messages
    isSending, // Loading state
    isLoading, // Initial data loading
    error, // Error state
    refetchMessages, // Refetch messages manually
    isRealTimeConnected, // WebSocket/SSE connection status
  } = useChat({
    oracleDid,
    sessionId,
    onPaymentRequiredError: (claimIds) => {
      // Handle payment requirements
      console.log('Payment required for claims:', claimIds);
    },
  });

  if (isLoading) return <div>Loading chat...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      {/* Connection indicator */}
      <div>
        Status: {isRealTimeConnected ? '🟢 Connected' : '🔴 Disconnected'}
      </div>

      {/* Messages */}
      <div className="messages">
        {messages.map((msg) => (
          <div key={msg.id} className={msg.type}>
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
        <input name="message" disabled={isSending} />
        <button type="submit" disabled={isSending}>
          {isSending ? 'Sending...' : 'Send'}
        </button>
      </form>
    </div>
  );
}
```

### Streaming Modes

Control how streaming updates are handled for different use cases:

```tsx
// Real-time streaming - immediate updates as they arrive (default)
const { messages } = useChat({
  oracleDid,
  sessionId,
  streamingMode: 'immediate', // or omit for default behavior
  onPaymentRequiredError: handlePayment,
});

// Batched streaming - optimized for performance
const { messages } = useChat({
  oracleDid,
  sessionId,
  streamingMode: 'batched', // Updates batched at ~60fps
  onPaymentRequiredError: handlePayment,
});
```

**When to use each mode:**

- **`immediate`** (default): Live typing effects, real-time collaboration, when you want users to see text appearing character by character
- **`batched`**: High-volume streaming, mobile devices, when performance is more important than visual smoothness

### Sending Messages with Metadata

Attach custom metadata to messages:

```tsx
await sendMessage('Hello', {
  source: 'mobile',
  timestamp: Date.now(),
  userContext: { mood: 'happy' },
});
```

## Choosing a Model

Let users pick which model answers their messages — like the model switcher in
ChatGPT or Claude. `useModels` fetches the oracle's catalog (each model comes
with a friendly name, a `$` / `$$` / `$$$` cost cue and a `Fast` / `Balanced` /
`Smartest` badge), and you pass the chosen `model` id to `useChat`.

Model is a conversation-level setting: the value in effect when a message is
sent is the one used to answer it, and the user can switch anytime.

```tsx
import { useState } from 'react';
import { useModels, useChat } from '@ixo/oracles-client-sdk';

function Chat({
  oracleDid,
  sessionId,
}: {
  oracleDid: string;
  sessionId: string;
}) {
  const { models, defaultModelId, isLoading } = useModels(oracleDid);
  const [model, setModel] = useState<string | undefined>(undefined);

  const { sendMessage } = useChat({
    oracleDid,
    sessionId,
    model: model ?? defaultModelId, // omit → the oracle's default (GPT-5.4 Nano)
    onPaymentRequiredError: (claimIds) => {
      /* prompt to top up */
    },
  });

  return (
    <select
      value={model ?? defaultModelId ?? ''}
      onChange={(e) => setModel(e.target.value)}
      disabled={isLoading}
    >
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label} · {m.costLabel} {m.badge}
        </option>
      ))}
    </select>
  );
}
```

Notes:

- The endpoint is public, so the picker renders before the user has an active
  subscription.
- `useModels` returns `{ models, defaultModelId, defaultModel, isLoading, error, refetch }`.
- Each `ModelInfo` has `id`, `label`, `family`, `tier`, `costLabel`, `badge`,
  `blurb`, `vision`, `pricing` (the price the user pays, markup included) and
  `isDefault`. For a non-technical audience, show `costLabel` + `badge` rather
  than raw token prices.
- Persisting the choice (e.g. in `localStorage`) is up to your app.

## Rendering Messages

Messages are stored as **plain data** (not React elements) for performance. Use `renderMessageContent` to transform them into UI.

### Basic Rendering

```tsx
import { renderMessageContent } from '@ixo/oracles-client-sdk';

function MessageList({ messages }) {
  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id} className={msg.type}>
          {/* Automatically handles strings and components */}
          {renderMessageContent(msg.content)}
        </div>
      ))}
    </div>
  );
}
```

### Message Content Types

Messages can contain three types of content:

1. **String** - Plain text
2. **Component Metadata** - Custom UI component data
3. **Array** - Mix of strings and components

```typescript
// String content
{
  id: 'msg-1',
  content: 'Hello world',
  type: 'human'
}

// Component metadata
{
  id: 'msg-2',
  content: {
    name: 'WeatherWidget',
    props: { city: 'New York', temp: 72 }
  },
  type: 'ai'
}

// Mixed array
{
  id: 'msg-3',
  content: [
    'Here is the weather:',
    {
      name: 'WeatherWidget',
      props: { city: 'New York', temp: 72 }
    }
  ],
  type: 'ai'
}
```

## Custom UI Components

Register custom React components to render rich, interactive content from the AI.

### Defining Components

Create components that accept specific props:

```tsx
// components/WeatherWidget.tsx
interface WeatherProps {
  city: string;
  temperature: number;
  condition: string;
  isLoading?: boolean;
}

export function WeatherWidget({
  city,
  temperature,
  condition,
  isLoading,
}: WeatherProps) {
  if (isLoading) {
    return <div>Loading weather for {city}...</div>;
  }

  return (
    <div className="weather-widget">
      <h3>{city}</h3>
      <div className="temp">{temperature}°C</div>
      <div className="condition">{condition}</div>
    </div>
  );
}
```

### Registering Components

Pass components to `useChat`:

```tsx
import { WeatherWidget } from './components/WeatherWidget';
import { PriceChart } from './components/PriceChart';

function Chat({ oracleDid, sessionId }) {
  const { messages, sendMessage } = useChat({
    oracleDid,
    sessionId,
    // Register your custom components
    uiComponents: {
      WeatherWidget,
      PriceChart,
      // Add more components as needed
    },
    onPaymentRequiredError: () => {},
  });

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id}>
          {/* Components are automatically rendered when referenced */}
          {renderMessageContent(msg.content, uiComponents)}
        </div>
      ))}
    </div>
  );
}
```

### Component Props Convention

All custom components receive standard props:

- `isLoading?: boolean` - True while component data is streaming
- `id: string` - Unique identifier
- Custom props from your component definition

## AG-UI Actions

AG-UI (Agentic UI) Actions enable the AI oracle to dynamically generate and control user interface components in your application.

### What Are AG-UI Actions?

AG-UI actions are **frontend tools** that combine business logic with UI rendering:

- Run in the user's browser
- Orchestrated by the AI oracle
- Have both handler (logic) and render (UI) functions
- Use Zod schemas for type-safe validation
- Can maintain state across operations

### When to Use AG-UI Actions

Use AG-UI actions when you want the AI to:

- **Create Dashboards** - Multi-component layouts with data visualization
- **Generate Forms** - Dynamic forms based on user needs
- **Build Data Tables** - Structured data display with sorting/filtering
- **Compose Charts** - Data visualization components
- **Manage Complex UI** - Any stateful, multi-operation interface

### Basic Setup

Register an AG-UI action using the `useAgAction` hook:

```tsx
import { useAgAction } from '@ixo/oracles-client-sdk';
import { z } from 'zod';

function ChatInterface() {
  useAgAction({
    name: 'create_data_table',
    description: 'Create a data table with columns and rows',
    parameters: z.object({
      title: z.string().optional(),
      columns: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          type: z.enum(['string', 'number', 'boolean']).optional(),
        }),
      ),
      data: z.array(z.record(z.any())),
    }),

    handler: async (args) => {
      // Execute logic (save to state, validate, etc.)
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

### Working Example

Here's a complete example with the DataTable component:

```tsx
// Define the schema with descriptions
const createDataTableSchema = z.object({
  title: z.string().optional().describe('Optional table title'),
  columns: z
    .array(
      z.object({
        key: z.string().describe('Data key for this column'),
        label: z.string().describe('Display label'),
        type: z.enum(['string', 'number', 'boolean']).optional(),
      }),
    )
    .describe('Column definitions'),
  data: z.array(z.record(z.any())).describe('Array of row objects'),
});

// Register the action
function ChatInterface() {
  useAgAction({
    name: 'create_data_table',
    description: 'Create a data table with structured data',
    parameters: createDataTableSchema,

    handler: async (args) => {
      console.log('Creating table with', args.data.length, 'rows');
      return {
        success: true,
        rowCount: args.data.length,
      };
    },

    render: ({ status, args }) => {
      if (status === 'done' && args) {
        return (
          <DataTable
            title={args.title}
            columns={args.columns}
            data={args.data}
          />
        );
      }
      return null;
    },
  });
}

// The DataTable component
interface DataTableProps {
  title?: string;
  columns: Array<{ key: string; label: string; type?: string }>;
  data: Record<string, any>[];
}

function DataTable({ title, columns, data }: DataTableProps) {
  return (
    <div className="data-table">
      {title && <h3>{title}</h3>}
      <table>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, idx) => (
            <tr key={idx}>
              {columns.map((col) => (
                <td key={col.key}>{row[col.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

**How the AI uses it:**

```
User: "Show me a table of top 3 customers"

AI: [calls create_data_table with]
{
  "title": "Top 3 Customers",
  "columns": [
    { "key": "name", "label": "Name" },
    { "key": "revenue", "label": "Revenue", "type": "number" }
  ],
  "data": [
    { "name": "Acme Corp", "revenue": 125000 },
    { "name": "TechStart", "revenue": 98000 },
    { "name": "InnovateCo", "revenue": 87500 }
  ]
}
```

### State Management

Use refs to maintain state across multiple operations:

```tsx
import { useRef } from 'react';

function ChatInterface() {
  // State persists across AI calls
  const dashboardStateRef = useRef({
    components: new Map(),
  });

  useAgAction({
    name: 'manage_dashboard',
    description: 'Manage dashboard components',
    parameters: manageDashboardSchema,

    handler: async (args) => {
      // Read current state
      const currentState = dashboardStateRef.current;

      // Modify state
      if (args.operation === 'add') {
        currentState.components.set(args.id, args.component);
      }

      // State persists for next operation
      return { success: true };
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

### Advanced Usage: Multi-Operation Actions

Build sophisticated systems with discriminated unions:

```tsx
const manageDashboardSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('create'),
    components: z.array(componentSchema),
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

useAgAction({
  name: 'manage_dashboard',
  description:
    'Create and manage dashboards with operations: create, add_component, remove_component',
  parameters: manageDashboardSchema,

  handler: async (args) => {
    switch (args.operation) {
      case 'create':
        // Create new dashboard
        return { success: true, operation: 'create' };
      case 'add_component':
        // Add component
        return { success: true, operation: 'add_component' };
      case 'remove_component':
        // Remove component
        return { success: true, operation: 'remove_component' };
    }
  },

  render: ({ status }) => {
    if (status === 'done') {
      return <DashboardCanvas state={dashboardStateRef.current} />;
    }
    return null;
  },
});
```

### Link to Full Guide

For comprehensive documentation, examples, and best practices, see:

- [AG-UI Tools Guide](./AG_UI_TOOLS.md) - Complete guide with advanced examples
- [API Reference](./API_REFERENCE.md#useagaction) - API documentation

## Streaming

Messages stream in real-time with optimized performance.

### How Streaming Works

1. User sends a message
2. AI response streams chunk by chunk
3. Each chunk triggers a state update
4. RAF batching prevents excessive re-renders
5. Final message is persisted

### Performance Characteristics

- Smooth 60fps even at 100+ chunks/second
- RAF batching coalesces rapid updates
- Minimal memory allocations
- ~75% less CPU than naive implementations

### Monitoring Streaming State

```tsx
const { isSending, status } = useChat({
  oracleDid,
  sessionId,
  onPaymentRequiredError: () => {},
});

// status can be: 'ready' | 'submitted' | 'streaming' | 'error'
console.log('Chat status:', status);
console.log('Is sending:', isSending);
```

## Error Handling

### Common Errors

#### Payment Required

```tsx
const { sendMessage } = useChat({
  oracleDid,
  sessionId,
  onPaymentRequiredError: (claimIds) => {
    // Show payment modal
    alert(`Please complete payment for claims: ${claimIds.join(', ')}`);

    // Use useContractOracle to handle payment
  },
});
```

#### Connection Errors

```tsx
const { error, isRealTimeConnected } = useChat({
  oracleDid,
  sessionId,
  onPaymentRequiredError: () => {},
});

if (error) {
  return (
    <div className="error">
      <h3>Error</h3>
      <p>{error.message}</p>
      <button onClick={() => refetchMessages()}>Retry</button>
    </div>
  );
}

if (!isRealTimeConnected) {
  return <div className="warning">Reconnecting...</div>;
}
```

#### Session Errors

```tsx
const { error, createSession } = useOracleSessions(oracleDid);

if (error) {
  return (
    <div>
      <p>Failed to load sessions: {error.message}</p>
      <button onClick={() => createSession()}>Create New Session</button>
    </div>
  );
}
```

## Best Practices

### 1. Always Use renderMessageContent

```tsx
// ✅ Correct
{
  messages.map((msg) => (
    <div key={msg.id}>{renderMessageContent(msg.content, uiComponents)}</div>
  ));
}

// ❌ Wrong - won't render components
{
  messages.map((msg) => <div key={msg.id}>{msg.content}</div>);
}
```

### 2. Memoize UI Components

```tsx
const uiComponents = useMemo(
  () => ({
    WeatherWidget,
    PriceChart,
  }),
  [],
); // Don't recreate on every render
```

### 3. Handle Loading States

```tsx
if (isLoading) return <Skeleton />;
if (!sessionId) return <div>Create a session to start</div>;
```

### 4. Optimize Re-renders

```tsx
// Wrap message rendering in memo if list is large
const Message = memo(({ message, uiComponents }) => (
  <div className={message.type}>
    {renderMessageContent(message.content, uiComponents)}
  </div>
));

function MessageList({ messages, uiComponents }) {
  return (
    <div>
      {messages.map((msg) => (
        <Message key={msg.id} message={msg} uiComponents={uiComponents} />
      ))}
    </div>
  );
}
```

### AG-UI Actions Best Practices

#### 5. Use Descriptive Action Names

```tsx
// ✅ Good - clear intent
useAgAction({ name: 'create_data_table', ... });
useAgAction({ name: 'manage_dashboard', ... });

// ❌ Bad - ambiguous
useAgAction({ name: 'table', ... });
useAgAction({ name: 'action1', ... });
```

#### 6. Add Schema Descriptions

```tsx
// ✅ Good - helps the AI understand
z.object({
  query: z
    .string()
    .describe(
      'Search query in natural language. Example: "documents about climate change"',
    ),
  limit: z.number().min(1).max(50).describe('Maximum results to return (1-50)'),
});

// ❌ Bad - no guidance for AI
z.object({
  query: z.string(),
  limit: z.number(),
});
```

#### 7. Use Refs for Stateful Actions

```tsx
// ✅ Good - state persists across operations
const dashboardRef = useRef({ components: new Map() });

useAgAction({
  handler: async (args) => {
    dashboardRef.current.components.set(id, component);
    return { success: true };
  },
});

// ❌ Bad - useState causes unnecessary re-renders
const [dashboard, setDashboard] = useState({ components: new Map() });
```

#### 8. Use Discriminated Unions for Multi-Operation Actions

```tsx
// ✅ Good - type-safe operations
const schema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), data: z.any() }),
  z.object({ operation: z.literal('update'), id: z.string() }),
]);

// ❌ Bad - no type safety
const schema = z.object({
  operation: z.enum(['create', 'update']),
  id: z.string().optional(),
  data: z.any().optional(),
});
```

#### 9. Return Meaningful Results from Handlers

```tsx
// ✅ Good - informative
handler: async (args) => {
  return {
    success: true,
    operation: 'create',
    componentCount: 5,
    message: 'Dashboard created with 5 components',
  };
};

// ❌ Bad - minimal info
handler: async (args) => {
  return { success: true };
};
```

#### 10. Throw Descriptive Errors

```tsx
// ✅ Good - helps AI correct mistakes
handler: async (args) => {
  if (args.data.length === 0) {
    throw new Error(
      'Cannot create table with empty data. ' +
        'Please provide at least one row. ' +
        'Example: [{"name": "John", "age": 30}]',
    );
  }
};

// ❌ Bad - vague error
handler: async (args) => {
  if (args.data.length === 0) {
    throw new Error('Invalid data');
  }
};
```

## Next Steps

- [API Reference](./API_REFERENCE.md) - Complete API documentation
- [Examples](./EXAMPLES.md) - Practical code examples
- [Live Agent Guide](./LIVE_AGENT.md) - Voice & video calls
