# @ixo/matrix

## 1.2.34

### Patch Changes

- [#318](https://github.com/ixoworld/qiforge/pull/318) [`9bb456a`](https://github.com/ixoworld/qiforge/commit/9bb456a87f161d4fd787f91b16ea6cda13226a1c) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Dependency updates. The LangGraph stack moves to `@langchain/langgraph` 1.4.17, `@langchain/langgraph-checkpoint` 1.1.5, `@langchain/langgraph-checkpoint-sqlite` 1.0.4, `@langchain/langgraph-checkpoint-validation` 1.1.1 and `@langchain/mcp-adapters` 1.1.4. Both SQLite checkpoint savers now accept the `counters_since_delta_snapshot` metadata key that `langgraph-checkpoint` 1.1.5 adds for delta channels. Also updates `@tavily/core` 0.7.12, `mammoth` 1.12.3, `@digitalbazaar/http-client` 4.4.0, `@changesets/changelog-github` ^0.7.0, and lockfile-only bumps for `jose`, `@ixo/matrix-crdt`, `@nestjs/swagger` and `vitest`.

## 1.1.0

### Minor Changes

- [#57](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/57) [`2a3bbd3`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/2a3bbd3267e1ce9a413eba4a30757e92ee8fa87b) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - # Live Agent: Ultra-Secure Voice & Video Calls

  This major release introduces **Live Agent Mode** - enabling real-time voice and video conversations with AI oracles through ultra-secure, end-to-end encrypted calls.

  ## ✨ Key Features
  - **Double Encryption Security**: Asymmetric key encryption + Matrix E2EE for maximum security
  - **Real-time Communication**: LiveKit integration for professional-grade WebRTC infrastructure
  - **Frontend-Controlled Keys**: True E2EE with user-generated encryption keys
  - **Zero-Trust Architecture**: Backend services cannot decrypt call content
  - **Per-Call Key Rotation**: Unique encryption keys for each call session

  ## 🏗️ New Components
  - `useLiveAgent` hook for voice chat integration
  - `useLiveKitAgent` for E2EE connection management
  - Complete call lifecycle with state validation
  - Enhanced Matrix integration for encrypted events

  ## 🛡️ Security Enhancements
  - ECIES-based encryption/decryption utilities
  - Cryptographically secure key generation
  - Live Agent authentication via API keys
  - Enhanced wallet generation with public key encoding

  ## 📡 New API Endpoints
  - `POST /calls/:callId/sync` - Sync call state from Matrix event
  - `GET /calls/:callId/key` - Get encrypted key for Live Agent
  - `PATCH /calls/:callId/update` - Update call status with validation
  - `GET /calls/session/:sessionId` - List user's call history

  ## ⚠️ Breaking Changes
  - **Backend only**: New environment variables required in your backend configuration:
    - `LIVE_AGENT_AUTH_API_KEY` - Authentication for Live Agent
    - `MEMORY_MCP_URL` - Memory management service URL
    - `MEMORY_MCP_API` - Memory management API endpoint
  - Updated dependencies for LiveKit and enhanced Matrix client

  ## 📚 Documentation
  - [Live Agent Architecture](./docs/architecture/calls.md) - Complete technical documentation
  - [Crypto Utilities](./packages/oracles-chain-client/docs/crypto.md) - Encryption implementation details

  This release represents a major milestone in secure, real-time AI communication, enabling truly private voice conversations with AI oracles through state-of-the-art encryption and professional-grade infrastructure.

## 1.0.2

### Patch Changes

- [`b723472`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/b72347286054e037436a8be3da3cf840f75223ca) Thanks [@yousefhany77](https://github.com/yousefhany77)! - fix bugs and some preformace updates

- [#53](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/53) [`0a4a5a8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/0a4a5a84194acb851e3824e0b74eea54f60c8257) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Upgrade packages and publish events package and preformance upgrades

## 1.0.1

### Patch Changes

- [#44](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/44) [`2b93cf8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/2b93cf8ef3839c36f03249b9392606211a22a0db) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - use matrix spaces and reduce using user mx token
