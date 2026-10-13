# @ixo/common

## Overview

The `@ixo/common` package holds the contracts QiForge runtimes and clients share — bounded semantic Decisions, the frontend bridge wire contract, portable work and AgentWake — plus the AI utilities and Matrix-backed services the deprecated Node runtime (`@ixo/oracle-runtime`) is built on.

The Workers runtime (`@ixo/oracle-runtime-workers`) imports only the three contract subpaths (`@ixo/common/ai/decisions`, `@ixo/common/ai/frontend-bridge`, `@ixo/common/work`); they run on workerd as well as Node.

## Table of Contents

1. [Entry points](#entry-points)
2. [Getting Started](#getting-started)
   - [Installation](#installation)
   - [Basic Usage](#basic-usage)
3. [Shared contracts](#shared-contracts)
   - [Decisions](#decisions-ixocommonaidecisions)
   - [Frontend bridge](#frontend-bridge-ixocommonaifrontend-bridge)
   - [Portable work and AgentWake](#portable-work-and-agentwake-ixocommonwork)
4. [Core Components](#core-components)
   - [AI Module](#ai-module)
   - [Services](#services)
5. [Documentation](#documentation)

## Entry points

| Import                           | What it holds                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@ixo/common`                    | Everything below, plus the services (`SessionManagerService`, `EnvService`, the memory engine client) and utils.                    |
| `@ixo/common/ai`                 | AI utilities, semantic router, LangChain tools and frontend tool callers, models, checkpointer; re-exports the two `ai/*` subpaths. |
| `@ixo/common/ai/decisions`       | The bounded semantic Decision module.                                                                                               |
| `@ixo/common/ai/frontend-bridge` | The frontend bridge wire contract.                                                                                                  |
| `@ixo/common/work`               | `PortableWorkDefinition` and `AgentWake` schemas.                                                                                   |

The package's `./*` export maps `@ixo/common/<path>` to `dist/<path>.js`, so a directory such as `services` is not importable by its directory name; import from the root instead.

## Getting Started

### Installation

```bash
# Install using pnpm (recommended)
pnpm install @ixo/common

# Or using npm
npm install @ixo/common

# Or using yarn
yarn add @ixo/common
```

### Environment Setup

The contract subpaths read no environment. The AI utilities read `process.env` when they are called: `LLM_PROVIDER` with `OPEN_ROUTER_API_KEY` or `NEBIUS_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (models), `TAVILY_API_KEY` (web search), `SESSION_TITLE_MODEL` (session titles), and `IXO_GURU_QUERY_ENDPOINT`, `GURU_ASSISTANCE_API_TOKEN`, `ORACLE_DID` (the IXO Guru tool).

### Basic Usage

```typescript
// AI utilities (root or @ixo/common/ai)
import { createSemanticRouter, docSplitter } from '@ixo/common/ai';

const chunks = await docSplitter('Long text content...');

const intentRouter = createSemanticRouter(
  {
    generateBlog: 'if the intent is blog',
    generatePost: 'if the intent is post',
  },
  ['intent'],
);
```

## Shared contracts

### Decisions (`@ixo/common/ai/decisions`)

Bounded semantic Decisions are side-effect-free, typed judgments over explicitly projected state: a Decision answers a finite question, and deterministic application code decides what follows. The module holds `defineDecision`, `DecisionRuntime`, provider routing (`DecisionProviderRegistry`, `DecisionProviderRouter`, `HOST_DECISION_PROVIDER_ID`, `AmbiguousDecisionProviderError`), applicability (`DecisionNotApplicableError`), Final Decision Subject binding (`canonicalizeFinalDecisionSubject`, `digestFinalDecisionSubject`, `createDecisionAuthorityReceipt`, `createDecisionExecutionReceipt`, `assertFinalDecisionSubjectUnchanged`, `StaleDecisionSubjectError`), the `measureDecisionQuestionIsolation` conformance probe, the Jev adapters (OpenRouter, Cloudflare, Workers AI), env-driven provider resolution (`resolveDecisionAdapter`, `decisionProviderEnvShape`) and the capability-router Decision.

The design, the runtime invariants and how to choose a provider are in [`docs/architecture/decisions.md`](../../docs/architecture/decisions.md); the Workers env variables and the `createOracleWorker({ decisionProviders, decisionProviderPolicy })` options are in the runtime's [`configuration.md`](../oracle-runtime-workers/docs/configuration.md#decisions).

### Frontend bridge (`@ixo/common/ai/frontend-bridge`)

The wire contract for browser tools (`browser_tool_call` → `tool_result`) and AG-UI actions (`action_call` → `action_call_result`): `FRONTEND_BRIDGE` (what `GET /health` advertises under `frontendTools`: protocol version 2, single-socket execution, unknown outcome on timeout), `frontendOutcomeUnknown` and `FRONTEND_OUTCOME_UNKNOWN` (the result of a call whose answer never arrived), `frontendInvocationId` (`<caller id>:<uuid>`), `reportsUnknownOutcome` and `summarizeFrontendResult` (identifiers and status only, for action logs). It has no dependencies. `callFrontendTool`, `callBrowserTool` and `callAgAction` in `@ixo/common/ai` follow it; the last two accept `onInvocation`. The Workers behaviour is in [`frontend-bridge.md`](../oracle-runtime-workers/docs/frontend-bridge.md).

### Portable work and AgentWake (`@ixo/common/work`)

Provider-neutral Zod schemas. `PortableWorkDefinitionSchema` describes reusable work by definition only (title, intent, outcome, definition of done, rubric refs, suggested roles and capabilities, scalar `configurationDefaults`); it rejects duplicate list entries and any key in `PORTABLE_WORK_RESERVED_CONFIGURATION_KEYS` (authority, credentials, approvals, execution state). `AgentWakeSchema` is a notify-only wake envelope (`notifyOnly: true`), `AgentWakeAcknowledgementSchema` its acknowledgement (`received`, `duplicate`, `superseded`), and `agentWakeDedupeKey` keys a wake by principal and wake id. The Workers task adapter validates its output against these schemas.

## Core Components

### AI Module

The AI module provides a comprehensive suite of AI-powered tools and utilities:

- **Document Processing**
  - Text splitting and chunking
  - Document relevance checking (`doc-relevance-checker.ts` has only a default export, so `checkDocRelevance` is not reachable through the package entry points)
  - File loading and format conversion
  - Similarity search filtering

- **Semantic Routing**
  - Intent-based routing
  - OpenAI integration
  - LangSmith tracing support

- **Search and Retrieval**
  - Web search integration with Tavily
  - Vector similarity search
  - Document retrieval tools

- **Frontend tool callers**
  - `callFrontendTool`, `callBrowserTool`, `callAgAction` (see [Frontend bridge](#frontend-bridge-ixocommonaifrontend-bridge))

- **Utility Functions**
  - YAML/JSON conversion
  - Document stringification
  - Array manipulation

### Services

Services used by the deprecated Node runtime (exported from the root):

- **Memory engine client** (`MemoryEngineService`)

- **Session Manager** (`SessionManagerService`, constructed with a database sync service)
  - Chat session management
  - AI-powered session titling
  - Matrix state persistence
  - Session lifecycle handling

- **Environment Service**
  - Type-safe environment variable management
  - Zod schema validation
  - Singleton pattern implementation
  - Runtime environment validation

### Using the Environment Service

The Environment Service provides a type-safe way to manage and access environment variables in your application. Here's the recommended way to structure and use it:

#### 1. Define Your Schema (schema.ts)

```typescript
// src/services/env/schema.ts
import z from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  PORT: z.string().transform(Number),
  API_KEY: z.string().min(1),
  // Add more environment variables as needed
});

// Export the schema type for type-safety
export type Schema = typeof envSchema;
```

#### 2. Create Singleton Instance (env.ts)

```typescript
// src/services/env/env.ts
import { EnvService } from '@ixo/common';
import { type Schema } from './schema';

const envService = EnvService.getInstance<Schema>();

export default envService;
```

`getInstance` throws until `EnvService.initialize` has run, so this module must be loaded after step 3.

#### 3. Initialize in Application Entry Point

```typescript
// src/main.ts or src/app.ts
import { EnvService } from '@ixo/common';
import { envSchema } from './services/env/schema';

async function bootstrap() {
  // Initialize environment service first
  EnvService.initialize(envSchema);

  // Now you can start your application
  const app = express();
  // ... rest of your application setup
}

bootstrap();
```

#### 4. Use Throughout Your Application

```typescript
// Any file where you need env variables - use the singleton instance you created in your app
import env from './services/env/env';

// Type-safe environment usage
const port = env.get('PORT'); // TypeScript knows this is a number
const apiKey = env.get('API_KEY'); // TypeScript knows this is a string

// Example usage in a service
export class DatabaseService {
  constructor() {
    this.connect({
      port: env.get('PORT'),
      apiKey: env.get('API_KEY'),
    });
  }
}
```

This pattern provides several benefits:

- **Single Source of Truth**: Environment schema is defined in one place
- **Type Safety**: TypeScript knows the types of all environment variables
- **Early Validation**: Environment is validated when the application starts
- **Clean Imports**: Simple import of the pre-configured service
- **Separation of Concerns**: Schema definition, initialization, and usage are separated

## Documentation

Detailed documentation is available in the [docs](./docs) directory:

- [AI Module Documentation](./docs/ai-module.md) - AI tools and utilities
- [Services Documentation](./docs/services.md) - Matrix services
- [Tools Documentation](./docs/tools.md) - Utility tools and helpers

## License

Internal package - All rights reserved.
