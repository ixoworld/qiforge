# AG-UI Tools Guide

Complete guide to building dynamic, AI-generated user interfaces with AG-UI Actions.

## Table of Contents

- [Understanding AG-UI Tools](#understanding-ag-ui-tools)
- [Core Concepts](#core-concepts)
- [The useAgAction Hook](#the-useagaction-hook)
- [Basic Example: Data Table](#basic-example-data-table)
- [Advanced Example: Multi-Component Dashboards](#advanced-example-multi-component-dashboards)
- [Schema Definition Best Practices](#schema-definition-best-practices)
- [Rendering Patterns](#rendering-patterns)
- [Error Handling](#error-handling)
- [State Management](#state-management)
- [Integration with Chat](#integration-with-chat)
- [Best Practices](#best-practices)
- [Complete Working Example](#complete-working-example)

---

## Understanding AG-UI Tools

AG-UI (Agentic UI) Tools are a powerful feature that allows AI oracles to dynamically generate and control user interface components in your application.

### What Are AG-UI Tools?

AG-UI tools are **frontend actions** that:

- Run in the user's browser
- Are orchestrated by the AI oracle
- Can create, update, and manage complex UI components
- Have both business logic (handler) and UI rendering (render)
- Use Zod schemas for type-safe validation

### How They Differ from Other Tools

| Feature         | Server-side Tools     | Browser Tools          | AG-UI Tools               |
| --------------- | --------------------- | ---------------------- | ------------------------- |
| **Execution**   | Oracle backend        | User's browser         | User's browser            |
| **Purpose**     | API calls, DB queries | Access local resources | Generate dynamic UI       |
| **Has UI**      | Yes (generic)         | Yes (generic)          | Yes (custom render)       |
| **Has Handler** | Backend only          | Frontend only          | Frontend handler + render |
| **Validation**  | Backend               | Schema only            | Automatic Zod validation  |
| **State**       | Stateless             | Stateless              | Can maintain state        |

### Why AG-UI Tools?

- ✅ **Dynamic UI Generation** - Let the AI create dashboards, forms, and visualizations
- ✅ **Type-Safe** - Full TypeScript support with Zod schema inference
- ✅ **Stateful** - Maintain state across multiple operations
- ✅ **Composable** - Build complex UIs from simple components
- ✅ **Real-time** - Instant updates via SSE streaming
- ✅ **Validated** - Automatic schema validation with detailed error messages

---

## Core Concepts

### Handler Function

The handler executes your business logic:

```typescript
handler: async (args) => {
  // Validate data
  // Execute operations
  // Return results
  return { success: true, data: processedData };
};
```

**Key characteristics:**

- Receives validated args (Zod ensures type safety)
- Can be async
- Returns any data structure
- Errors are automatically caught and displayed

### Render Function

The render function creates the visual representation:

```typescript
render: ({ status, args, result }) => {
  if (status === 'done') {
    return <YourComponent {...args} />;
  }
  return null; // or loading state
}
```

**Key characteristics:**

- Called when action status changes
- Receives status ('isRunning' | 'done' | 'error')
- Can return null (no inline render) or React elements
- Typically used with a canvas or modal

### Schema Validation

Zod schemas define and validate your action's parameters:

```typescript
parameters: z.object({
  title: z.string().describe('The table title'),
  data: z.array(z.any()).describe('Array of row objects'),
});
```

**Key characteristics:**

- Automatic validation before handler execution
- TypeScript type inference
- Detailed error messages sent to the AI
- `.describe()` provides context to the LLM

---

## The useAgAction Hook

Register AG-UI actions that the oracle can invoke.

### Signature

```typescript
function useAgAction<TSchema extends z.ZodTypeAny>(
  config: AgActionConfig<TSchema>,
): void;
```

### Configuration Interface

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

### Parameters

| Parameter     | Type        | Required | Description                                          |
| ------------- | ----------- | -------- | ---------------------------------------------------- |
| `name`        | `string`    | Yes      | Unique identifier for the action                     |
| `description` | `string`    | Yes      | Description visible to the AI (include schema hints) |
| `parameters`  | `ZodSchema` | Yes      | Zod schema for validation                            |
| `handler`     | `function`  | Yes      | Executes the action logic                            |
| `render`      | `function`  | No       | Renders the UI component                             |

### Lifecycle

1. **Registration** - Action registered on component mount
2. **Invocation** - AI oracle calls the action with arguments
3. **Validation** - SDK validates args against schema
4. **Execution** - Handler runs if validation passes
5. **Rendering** - Render function called with status='done'
6. **Cleanup** - Action unregistered on component unmount

---

## Basic Example: Data Table

Create a simple action that generates data tables.

### Schema Definition

```typescript
import { z } from 'zod';

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
```

### Component Implementation

```typescript
import { useAgAction } from '@ixo/oracles-client-sdk';
import { DataTable } from './components/DataTable';

function ChatInterface() {
  useAgAction({
    name: 'create_data_table',
    description: 'Create a data table with columns and rows',
    parameters: createDataTableSchema,

    handler: async (args) => {
      // Handler logic (e.g., save to state, validate data)
      console.log('Creating table with', args.data.length, 'rows');

      return {
        success: true,
        rowCount: args.data.length
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

  // ... rest of your chat interface
}
```

### DataTable Component

```typescript
interface Column {
  key: string;
  label: string;
  type?: 'string' | 'number' | 'boolean';
}

interface DataTableProps {
  title?: string;
  columns: Column[];
  data: Record<string, any>[];
}

export function DataTable({ title, columns, data }: DataTableProps) {
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

### How the AI Uses It

```
User: "Show me a table of top 5 customers with name, email, and revenue"

AI: [calls create_data_table with]
{
  "title": "Top 5 Customers",
  "columns": [
    { "key": "name", "label": "Name", "type": "string" },
    { "key": "email", "label": "Email", "type": "string" },
    { "key": "revenue", "label": "Revenue", "type": "number" }
  ],
  "data": [
    { "name": "Acme Corp", "email": "contact@acme.com", "revenue": 125000 },
    { "name": "TechStart Inc", "email": "hello@techstart.io", "revenue": 98000 },
    ...
  ]
}
```

---

## Advanced Example: Multi-Component Dashboards

Build a sophisticated dashboard system with multiple operations.

### The Pattern

A single AG-UI action can support multiple operations using **discriminated unions**:

```typescript
const dashboardSchema = z.discriminatedUnion('operation', [
  createOperationSchema,
  updateLayoutOperationSchema,
  updateDataOperationSchema,
  addComponentOperationSchema,
  removeComponentOperationSchema,
]);
```

### Schema Definition

```typescript
// Position schema for 12-column grid
const positionSchema = z.object({
  col: z.number().min(1).max(12).describe('Starting column (1-12)'),
  row: z.number().min(1).describe('Starting row (1+)'),
  colSpan: z.number().min(1).max(12).describe('Column span (1-12)'),
  rowSpan: z.number().min(1).default(1).describe('Row span (default: 1)'),
});

// Component definition
const componentSchema = z.object({
  id: z.string().describe('Unique component ID'),
  type: z.enum(['data_table', 'metric_card', 'text']),
  position: positionSchema,
  data: z.any().describe('Component-specific data'),
});

// Create operation
const createOperationSchema = z.object({
  operation: z.literal('create'),
  components: z.array(componentSchema).min(1),
});

// Update layout operation
const updateLayoutOperationSchema = z.object({
  operation: z.literal('update_layout'),
  changes: z
    .array(
      z.object({
        id: z.string(),
        position: positionSchema,
      }),
    )
    .min(1),
});

// Add component operation
const addComponentOperationSchema = z.object({
  operation: z.literal('add_component'),
  component: componentSchema,
});

// Remove component operation
const removeComponentOperationSchema = z.object({
  operation: z.literal('remove_component'),
  componentId: z.string(),
});

// Main schema
export const manageDashboardSchema = z.discriminatedUnion('operation', [
  createOperationSchema,
  updateLayoutOperationSchema,
  addComponentOperationSchema,
  removeComponentOperationSchema,
]);
```

### Handler with State Management

```typescript
import { useRef } from 'react';

function ChatInterface() {
  // Use ref to persist state across operations
  const dashboardStateRef = useRef<DashboardState>({
    layout: { type: 'grid', columns: 12, gap: 'md' },
    components: new Map(),
  });

  useAgAction({
    name: 'manage_dashboard',
    description:
      'Create and manage multi-component dashboards with a 12-column grid. ' +
      'Operations: create, update_layout, add_component, remove_component.',
    parameters: manageDashboardSchema,

    handler: async (args) => {
      const currentState = dashboardStateRef.current;

      switch (args.operation) {
        case 'create': {
          const newComponents = new Map();
          args.components.forEach(comp => {
            newComponents.set(comp.id, {
              ...comp,
              data: comp.data || {},
            });
          });
          dashboardStateRef.current = {
            layout: currentState.layout,
            components: newComponents,
          };
          return {
            success: true,
            operation: 'create',
            componentCount: newComponents.size
          };
        }

        case 'update_layout': {
          args.changes.forEach(change => {
            const existing = currentState.components.get(change.id);
            if (existing) {
              currentState.components.set(change.id, {
                ...existing,
                position: change.position,
              });
            }
          });
          return {
            success: true,
            operation: 'update_layout',
            updated: args.changes.length
          };
        }

        case 'add_component': {
          const componentWithData = {
            ...args.component,
            data: args.component.data || {},
          };
          currentState.components.set(
            args.component.id,
            componentWithData
          );
          return {
            success: true,
            operation: 'add_component',
            componentId: args.component.id
          };
        }

        case 'remove_component': {
          const existed = currentState.components.has(args.componentId);
          currentState.components.delete(args.componentId);
          return {
            success: true,
            operation: 'remove_component',
            removed: existed
          };
        }

        default:
          throw new Error('Unknown operation');
      }
    },

    render: ({ status }) => {
      if (status === 'done') {
        return (
          <DashboardCanvas state={dashboardStateRef.current} />
        );
      }
      return null;
    },
  });
}
```

### Dashboard Canvas Component

```typescript
interface DashboardCanvasProps {
  state: DashboardState;
  status?: 'isRunning' | 'done' | 'error';
}

// Component registry
const componentRegistry: Record<string, React.ComponentType<any>> = {
  data_table: DataTable,
  metric_card: MetricCard,
  text: TextBlock,
};

export function DashboardCanvas({ state, status = 'done' }: DashboardCanvasProps) {
  if (status === 'isRunning') {
    return <div>Creating dashboard...</div>;
  }

  const components = Array.from(state.components.values());

  return (
    <div className="dashboard-container">
      <GridLayout columns={state.layout.columns} gap={state.layout.gap}>
        {components.map(component => {
          const Component = componentRegistry[component.type];

          if (!Component) {
            return (
              <div key={component.id}>
                Unknown component type: {component.type}
              </div>
            );
          }

          return (
            <GridItem
              key={component.id}
              col={component.position.col}
              row={component.position.row}
              colSpan={component.position.colSpan}
              rowSpan={component.position.rowSpan}
            >
              <Component {...component.data} />
            </GridItem>
          );
        })}
      </GridLayout>
    </div>
  );
}
```

### Grid Layout Components

```typescript
// GridLayout.tsx
interface GridLayoutProps {
  columns: number;
  gap: 'none' | 'sm' | 'md' | 'lg';
  children: React.ReactNode;
}

export function GridLayout({ columns, gap, children }: GridLayoutProps) {
  const gapClass = {
    none: 'gap-0',
    sm: 'gap-2',
    md: 'gap-4',
    lg: 'gap-6',
  }[gap];

  return (
    <div
      className={`grid ${gapClass}`}
      style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
    >
      {children}
    </div>
  );
}

// GridItem.tsx
interface GridItemProps {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  children: React.ReactNode;
}

export function GridItem({ col, row, colSpan, rowSpan, children }: GridItemProps) {
  return (
    <div
      style={{
        gridColumnStart: col,
        gridColumnEnd: col + colSpan,
        gridRowStart: row,
        gridRowEnd: row + rowSpan,
      }}
    >
      {children}
    </div>
  );
}
```

### How the AI Uses It

```
User: "Create a dashboard with a sales table and revenue metric"

AI: [calls manage_dashboard with]
{
  "operation": "create",
  "components": [
    {
      "id": "sales-table",
      "type": "data_table",
      "position": { "col": 1, "colSpan": 8, "row": 1, "rowSpan": 1 },
      "data": {
        "columns": [...],
        "data": [...]
      }
    },
    {
      "id": "revenue-card",
      "type": "metric_card",
      "position": { "col": 9, "colSpan": 4, "row": 1, "rowSpan": 1 },
      "data": {
        "title": "Total Revenue",
        "value": "$1.2M",
        "trend": "+12%"
      }
    }
  ]
}

User: "Move the table to take full width"

AI: [calls manage_dashboard with]
{
  "operation": "update_layout",
  "changes": [
    {
      "id": "sales-table",
      "position": { "col": 1, "colSpan": 12, "row": 1, "rowSpan": 1 }
    }
  ]
}
```

---

## Schema Definition Best Practices

### Use Descriptive Field Names

```typescript
// ✅ Good - clear intent
z.object({
  userEmail: z.string().email(),
  orderTotal: z.number().positive(),
});

// ❌ Bad - ambiguous
z.object({
  email: z.string(),
  total: z.number(),
});
```

### Add Descriptions for the AI

```typescript
z.object({
  query: z
    .string()
    .describe(
      'Search query to find relevant documents. ' +
        'Use natural language, e.g., "documents about climate change"',
    ),
  maxResults: z
    .number()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of results to return (1-50, default: 10)'),
});
```

### Use Discriminated Unions for Operations

```typescript
// ✅ Good - type-safe operations
const schema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), data: z.any() }),
  z.object({ operation: z.literal('update'), id: z.string(), data: z.any() }),
  z.object({ operation: z.literal('delete'), id: z.string() }),
]);

// ❌ Bad - no type safety
const schema = z.object({
  operation: z.enum(['create', 'update', 'delete']),
  id: z.string().optional(),
  data: z.any().optional(),
});
```

### Provide Examples in Descriptions

```typescript
z.object({
  colors: z
    .array(z.string())
    .describe(
      'Array of color values. ' +
        'Examples: ["#FF0000", "#00FF00"] or ["red", "blue", "green"]',
    ),
});
```

### Use Enums for Fixed Options

```typescript
z.object({
  chartType: z
    .enum(['bar', 'line', 'pie', 'scatter'])
    .describe('Chart type to display. Options: bar, line, pie, scatter'),
});
```

---

## Rendering Patterns

### Pattern 1: Canvas Rendering

Render in a dedicated canvas/panel:

```typescript
render: ({ status, args }) => {
  if (status === 'done') {
    const element = <YourComponent {...args} />;
    // Send to canvas via callback
    onAgUiRender(element);
    return null; // No inline render
  }
  return null;
}
```

**Use when:**

- Building dashboards or complex layouts
- Need full-screen or dedicated space
- Multiple components in one view

### Pattern 2: Inline Rendering

Render directly in the chat:

```typescript
render: ({ status, args }) => {
  if (status === 'done') {
    return <YourComponent {...args} />;
  }
  return null;
}
```

**Use when:**

- Simple components (cards, charts)
- Want to show in message history
- No need for dedicated canvas

### Pattern 3: Conditional Rendering

Show different UI based on status:

```typescript
render: ({ status, args, result }) => {
  if (status === 'isRunning') {
    return <LoadingSpinner message="Processing..." />;
  }

  if (status === 'error') {
    return <ErrorDisplay message="Failed to process" />;
  }

  if (status === 'done' && result?.success) {
    return <SuccessView data={result.data} />;
  }

  return null;
}
```

**Use when:**

- Long-running operations
- Need to show progress
- Want error state UI

### Pattern 4: No Render Function

Handler only, no visual component:

```typescript
useAgAction({
  name: 'save_preferences',
  description: 'Save user preferences',
  parameters: preferencesSchema,
  handler: async (args) => {
    localStorage.setItem('prefs', JSON.stringify(args));
    return { success: true };
  },
  // No render function
});
```

**Use when:**

- Side effects only (save, delete)
- No visual representation needed
- Generic ToolCall UI is sufficient

---

## Error Handling

### Automatic Schema Validation

The SDK automatically validates args before calling your handler:

```typescript
// If validation fails, error is sent to AI with full schema
{
  "error": "Schema validation failed for action 'create_table'. " +
           "columns: Required. " +
           "data: Expected array, received string. " +
           "Required format: { ... full JSON schema ... }"
}
```

**The AI receives:**

1. Specific validation errors (which fields failed)
2. Full JSON schema representation
3. Clear instructions to retry with correct format

### Handler Errors

Throw errors in your handler for business logic failures:

```typescript
handler: async (args) => {
  if (args.data.length === 0) {
    throw new Error(
      'Cannot create table with empty data. ' +
        'Please provide at least one row.',
    );
  }

  if (args.data.length > 1000) {
    throw new Error(
      'Too many rows. Maximum 1000 rows allowed, ' +
        `received ${args.data.length} rows.`,
    );
  }

  // Process data
  return { success: true };
};
```

### Error Display in UI

Create a generic error component:

```typescript
interface AgActionToolCallProps {
  actionName: string;
  args: Record<string, unknown>;
  status?: 'isRunning' | 'done' | 'error';
  error?: string;
}

export function AgActionToolCall({
  actionName,
  args,
  status,
  error
}: AgActionToolCallProps) {
  return (
    <div className="ag-action-toolcall">
      <div className="header">
        <span className="icon">⚡</span>
        <span className="name">{formatName(actionName)}</span>
        {status === 'isRunning' && <Spinner />}
      </div>

      {status === 'error' && error && (
        <div className="error">
          <span className="icon">❌</span>
          <span className="message">{error}</span>
        </div>
      )}

      {status === 'done' && (
        <div className="success">
          <span className="icon">✓</span>
          <span>Action completed successfully</span>
        </div>
      )}
    </div>
  );
}
```

---

## State Management

### Using Refs for Persistent State

AG-UI actions can maintain state across multiple invocations:

```typescript
function ChatInterface() {
  // State persists across operations
  const dashboardStateRef = useRef<DashboardState>({
    layout: { type: 'grid', columns: 12, gap: 'md' },
    components: new Map(),
  });

  useAgAction({
    name: 'manage_dashboard',
    // ... config
    handler: async (args) => {
      // Read current state
      const currentState = dashboardStateRef.current;

      // Modify state
      currentState.components.set('new-id', newComponent);

      // State persists for next operation
      return { success: true };
    },
  });
}
```

### Why Use Refs?

**✅ Benefits:**

- State persists across multiple AI calls
- No re-renders when state changes
- Mutable updates (important for Maps, Sets)
- Synchronous access

**When to use:**

- Dashboard management (add/update/remove components)
- Form builders
- Multi-step workflows
- Any CRUD operations on UI state

### Alternative: useState

For simple, non-mutable state:

```typescript
function ChatInterface() {
  const [tableData, setTableData] = useState<any[]>([]);

  useAgAction({
    name: 'update_table',
    parameters: updateSchema,
    handler: async (args) => {
      setTableData(args.data);
      return { success: true };
    },
  });
}
```

**⚠️ Caution:**

- Triggers re-renders
- Async updates may cause race conditions
- Not suitable for Maps/Sets

---

## Integration with Chat

### How AG-UI Actions Work with Chat

1. **User sends message**: "Create a dashboard with sales data"
2. **AI decides to use action**: Calls `manage_dashboard`
3. **WebSocket event sent**: Frontend receives `action_call` event
4. **Validation**: SDK validates args against schema
5. **Handler executes**: Your handler runs with validated args
6. **SSE status update**: Status changes to 'done'
7. **Render function called**: Your render function creates UI
8. **Result in chat**: User sees the generated dashboard

### SSE Event Flow

```typescript
// 1. Action starts (status: 'isRunning')
{
  event: 'action_call',
  payload: {
    toolName: 'manage_dashboard',
    toolCallId: 'call-123',
    status: 'isRunning',
    args: { ... }
  }
}

// 2. Handler executes on frontend

// 3. Action completes (status: 'done')
{
  event: 'action_call',
  payload: {
    toolName: 'manage_dashboard',
    toolCallId: 'call-123',
    status: 'done',
    args: { ... },
    output: { success: true, ... }
  }
}

// 4. Render function called with status='done'
```

### Registering Multiple Actions

```typescript
function ChatInterface() {
  // Register multiple AG-UI actions
  useAgAction({ name: 'create_table', ... });
  useAgAction({ name: 'create_chart', ... });
  useAgAction({ name: 'manage_dashboard', ... });
  useAgAction({ name: 'create_form', ... });

  // All available to the AI
  const { messages, sendMessage } = useChat({
    oracleDid,
    sessionId,
    onPaymentRequiredError: handlePayment,
  });
}
```

### Custom UI Components for AG-UI Actions

Create a dedicated component for AG-UI tool calls:

```typescript
const uiComponents = {
  ToolCall, // Generic fallback
  AgActionToolCall, // Special rendering for AG actions
  // ... other components
};

const { messages } = useChat({
  oracleDid,
  sessionId,
  uiComponents,
  onPaymentRequiredError: handlePayment,
});
```

---

## Best Practices

### 1. Use Clear, Descriptive Names

```typescript
// ✅ Good
useAgAction({ name: 'create_data_table', ... });
useAgAction({ name: 'manage_dashboard', ... });

// ❌ Bad
useAgAction({ name: 'table', ... });
useAgAction({ name: 'action1', ... });
```

### 2. Provide Comprehensive Descriptions

```typescript
description: 'Create and manage multi-component dashboards with a 12-column grid layout. ' +
  'REQUIRED SCHEMA - operation: string ("create"|"update_layout"|"add_component"|"remove_component"). ' +
  'For CREATE operation: { "operation": "create", "components": [...] }. ' +
  'Position uses 12-column grid: col (1-12), colSpan (width), row (1+), rowSpan (height).';
```

### 3. Add Schema Descriptions and Examples

```typescript
z.object({
  columns: z.array(...).describe(
    'Column definitions. Each column needs: key (data field), label (display name), type (optional). ' +
    'Example: [{"key": "name", "label": "Name", "type": "string"}]'
  ),
})
```

### 4. Use Discriminated Unions for Multi-Operation Actions

```typescript
// ✅ Type-safe operations
z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), ... }),
  z.object({ operation: z.literal('update'), ... }),
])
```

### 5. Handle Errors Gracefully

```typescript
handler: async (args) => {
  try {
    // Execute logic
    return { success: true, data };
  } catch (error) {
    throw new Error(
      `Failed to process: ${error.message}. ` +
        'Please check the input format and try again.',
    );
  }
};
```

### 6. Use Refs for Stateful Actions

```typescript
// ✅ For dashboards, forms, multi-step workflows
const stateRef = useRef({ ... });

// ❌ Don't use useState for mutable collections
const [state, setState] = useState(new Map()); // Bad!
```

### 7. Render in Canvas for Complex UIs

```typescript
render: ({ status, args }) => {
  if (status === 'done') {
    onAgUiRender(<ComplexDashboard {...args} />);
    return null; // No inline render
  }
  return null;
}
```

### 8. Test with Validation Errors

```typescript
// Test that AI receives helpful errors
handler: async (args) => {
  if (!args.data || args.data.length === 0) {
    throw new Error(
      'Missing or empty data array. ' +
        'Please provide at least one data item. ' +
        'Example: [{"name": "John", "age": 30}]',
    );
  }
  // ...
};
```

### 9. Return Meaningful Results

```typescript
handler: async (args) => {
  // ✅ Good - informative result
  return {
    success: true,
    operation: 'create',
    componentCount: 5,
    message: 'Dashboard created with 5 components',
  };

  // ❌ Bad - minimal info
  return { success: true };
};
```

### 10. Document Your Components

```typescript
/**
 * Creates a dynamic dashboard with multiple components in a 12-column grid.
 *
 * @example
 * User: "Create a dashboard with sales table and revenue card"
 *
 * Operations:
 * - create: Initialize new dashboard with components
 * - update_layout: Move/resize existing components
 * - add_component: Add new component to dashboard
 * - remove_component: Delete component by ID
 */
useAgAction({
  name: 'manage_dashboard',
  // ...
});
```

---

## Complete Working Example

Here's a full implementation of a dashboard system with AG-UI actions:

```typescript
// ChatInterface.tsx
import { useChat, useAgAction } from '@ixo/oracles-client-sdk';
import { useRef, useCallback, useState } from 'react';
import { DashboardCanvas, type DashboardState } from './components/DashboardCanvas';
import { manageDashboardSchema, type ManageDashboardInput } from './schemas/dashboard.schema';

export default function ChatInterface({ oracleDid, session, onAgUiRender }) {
  // Dashboard state persists across operations
  const dashboardStateRef = useRef<DashboardState>({
    layout: { type: 'grid', columns: 12, gap: 'md' },
    components: new Map(),
  });

  // Register the manage_dashboard AG-UI action
  useAgAction({
    name: 'manage_dashboard',
    description:
      'Create and manage multi-component dashboards with a 12-column grid layout. ' +
      'Operations: create (new dashboard), update_layout (move components), ' +
      'add_component (add new), remove_component (delete). ' +
      'Components: data_table, metric_card, text. ' +
      'Position: col (1-12), colSpan (width), row (1+), rowSpan (height).',
    parameters: manageDashboardSchema,

    handler: async (args) => {
      const operation = args as ManageDashboardInput;
      const currentState = dashboardStateRef.current;

      switch (operation.operation) {
        case 'create': {
          const newComponents = new Map();
          operation.components.forEach(comp => {
            newComponents.set(comp.id, {
              ...comp,
              data: comp.data || {},
            });
          });
          dashboardStateRef.current = {
            layout: currentState.layout,
            components: newComponents,
          };
          return {
            success: true,
            operation: 'create',
            componentCount: newComponents.size
          };
        }

        case 'update_layout': {
          operation.changes.forEach(change => {
            const existing = currentState.components.get(change.id);
            if (existing) {
              currentState.components.set(change.id, {
                ...existing,
                position: change.position,
              });
            }
          });
          return {
            success: true,
            operation: 'update_layout',
            updated: operation.changes.length
          };
        }

        case 'add_component': {
          const componentWithData = {
            ...operation.component,
            data: operation.component.data || {},
          };
          currentState.components.set(
            operation.component.id,
            componentWithData
          );
          return {
            success: true,
            operation: 'add_component',
            componentId: operation.component.id
          };
        }

        case 'remove_component': {
          const existed = currentState.components.has(operation.componentId);
          currentState.components.delete(operation.componentId);
          return {
            success: true,
            operation: 'remove_component',
            removed: existed
          };
        }

        default:
          throw new Error('Unknown operation');
      }
    },

    render: ({ status }) => {
      if (status === 'done') {
        const dashboardElement = (
          <DashboardCanvas
            state={dashboardStateRef.current}
            status={status}
          />
        );

        if (onAgUiRender) {
          onAgUiRender(dashboardElement);
        }

        return null; // Render in canvas, not inline
      }
      return null;
    },
  });

  // Chat setup
  const { messages, sendMessage, isSending } = useChat({
    oracleDid,
    sessionId: session?.sessionId,
    onPaymentRequiredError: (claims) => {
      console.log('Payment required:', claims);
    },
  });

  return (
    <div className="chat-interface">
      <div className="messages">
        {messages.map(msg => (
          <div key={msg.id} className={msg.type}>
            {renderMessageContent(msg.content)}
          </div>
        ))}
      </div>

      <MessageInput onSend={sendMessage} disabled={isSending} />
    </div>
  );
}
```

```typescript
// schemas/dashboard.schema.ts
import { z } from 'zod';

export const positionSchema = z.object({
  col: z.number().min(1).max(12).describe('Starting column (1-12)'),
  row: z.number().min(1).describe('Starting row (1+)'),
  colSpan: z.number().min(1).max(12).describe('Column span (1-12)'),
  rowSpan: z.number().min(1).default(1).describe('Row span (default: 1)'),
});

export const componentSchema = z.object({
  id: z.string().describe('Unique component ID'),
  type: z.enum(['data_table', 'metric_card', 'text']),
  position: positionSchema,
  data: z.any().describe('Component-specific data'),
});

export const createOperationSchema = z.object({
  operation: z.literal('create'),
  components: z.array(componentSchema).min(1),
});

export const updateLayoutOperationSchema = z.object({
  operation: z.literal('update_layout'),
  changes: z
    .array(z.object({ id: z.string(), position: positionSchema }))
    .min(1),
});

export const addComponentOperationSchema = z.object({
  operation: z.literal('add_component'),
  component: componentSchema,
});

export const removeComponentOperationSchema = z.object({
  operation: z.literal('remove_component'),
  componentId: z.string(),
});

export const manageDashboardSchema = z.discriminatedUnion('operation', [
  createOperationSchema,
  updateLayoutOperationSchema,
  addComponentOperationSchema,
  removeComponentOperationSchema,
]);

export type ManageDashboardInput = z.infer<typeof manageDashboardSchema>;
```

---

## Next Steps

- [API Reference](./API_REFERENCE.md) - Complete SDK documentation
- [Usage Guide](./USAGE_GUIDE.md) - General SDK usage patterns
- [Tool Calls Guide](./TOOL_CALLS.md) - Browser tools and server tools
