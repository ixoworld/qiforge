# Services Documentation

## Overview

The Services module in `@ixo/common` provides essential services for managing Matrix rooms and chat sessions. It integrates with the Matrix protocol through `@ixo/matrix` and provides type-safe operations for room and session management.

## Core Services

### Room Manager Service

A service for managing Matrix rooms with support for creation, retrieval, and access control.

```typescript
import { RoomManagerService } from '@ixo/common/services';

const roomManager = new RoomManagerService();

// Create or get existing room
const roomId = await roomManager.getOrCreateRoom({
  did: 'user-did',
  oracleName: 'oracle-name',
  userAccessToken: 'matrix-access-token',
});

// Get room by DID and oracle name
const room = await roomManager.getRoom({
  did: 'user-did',
  oracleName: 'oracle-name',
});
```

#### Room Manager Capabilities

- Create new Matrix rooms
- Retrieve existing rooms by DID and oracle name
- Get or create rooms (idempotent operation)

#### Room Manager Types

```typescript
interface CreateRoomDto {
  did: string;
  oracleName: string;
  userAccessToken: string;
}

interface GetRoomDto {
  did: string;
  oracleName: string;
}
```

### Session Manager Service

A service for managing chat sessions with support for persistence in Matrix rooms.

```typescript
import { SessionManagerService } from '@ixo/common/services';

const sessionManager = new SessionManagerService();

// Create new chat session
const session = await sessionManager.createSession({
  did: 'user-did',
  oracleName: 'oracle-name',
  matrixAccessToken: 'access-token',
});

// List user's sessions
const { sessions } = await sessionManager.listSessions({
  did: 'user-did',
  matrixAccessToken: 'access-token',
});

// Delete a session
await sessionManager.deleteSession({
  did: 'user-did',
  sessionId: 'session-uuid',
  matrixAccessToken: 'access-token',
});
```

#### Session Manager Capabilities

- Create new chat sessions
- List existing sessions for a user
- Delete sessions
- Automatic session title generation using AI
- Session state persistence in Matrix rooms
- Type-safe operations with DTOs

#### Session Titles

A session is named **once**, on the first turn that carries both a real user
message and a real oracle reply. Until then it holds the `Untitled`
placeholder; after that the title is never regenerated.

`syncSessionSet` runs after every turn, so several turns can race to name the
same session. Two guards make the outcome exactly one title: an in-process
single-flight map collapses concurrent turns onto one model call, and the
write itself is conditional on the row still being untitled. The Matrix root
event is renamed only by the writer that actually landed.

The generated title is validated before it is stored — reasoning blocks,
`Title:` labels, quotes and markdown are stripped, and output that is a
sentence, a preamble ("Sure, here's a title…") or a verbatim slice of the
transcript is rejected. A rejected title falls back to the user's opening
request, clipped at a clause boundary, so the label is always about what the
user asked for.

Set `SESSION_TITLE_MODEL` to override the model used for naming; it defaults
to a small instruction-following model per `LLM_PROVIDER`.

#### Session Types

```typescript
interface ChatSession {
  sessionId: string;
  oracleName: string;
  title: string;
  lastUpdatedAt: string;
  createdAt: string;
}

interface CreateChatSessionDto {
  did: string;
  oracleName: string;
  matrixAccessToken: string;
}

interface ListChatSessionsDto {
  did: string;
  matrixAccessToken: string;
}

interface DeleteChatSessionDto {
  did: string;
  sessionId: string;
  matrixAccessToken: string;
}
```

## Error Handling

The services provide specific error types for common scenarios:

```typescript
import {
  NoUserRoomsFoundError,
  RoomNotFoundError,
  UserNotInRoomError,
} from '@ixo/common/services';

try {
  await operation();
} catch (error) {
  if (error instanceof NoUserRoomsFoundError) {
    // Handle case where user has no rooms
  } else if (error instanceof RoomNotFoundError) {
    // Handle case where specific room not found
  } else if (error instanceof UserNotInRoomError) {
    // Handle case where user doesn't have access
  }
}
```

## Integration with Matrix

Both services integrate with the Matrix protocol through `@ixo/matrix`:

- Uses Matrix rooms for persistence
- Leverages Matrix state events for session storage
- Handles Matrix authentication and access control
- Provides type-safe Matrix operations

## Best Practices

### Room Management

- Store room IDs for frequent access
- Handle room creation idempotently
- Validate user access tokens
- Use appropriate error handling

### Session Management

- Use UUIDs for session IDs
- Handle session state updates atomically
- Implement proper cleanup for deleted sessions
- Validate session access before operations
