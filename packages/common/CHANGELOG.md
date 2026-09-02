# @ixo/common

## 1.5.0

### Minor Changes

- [#242](https://github.com/ixoworld/qiforge/pull/242) [`b6cd393`](https://github.com/ixoworld/qiforge/commit/b6cd393e52c9e375189d1d3e9900f4b5f5cf571d) Thanks [@Michael-Ixo](https://github.com/Michael-Ixo)! - Bring-your-own-credential LLMs for the personal companion (`BYO_LLM_ENABLED`): users connect their ChatGPT subscription (Codex OAuth device flow) or per-provider API keys (OpenAI, Anthropic, Gemini, DeepSeek), stored as server-encrypted secrets in the canonical user↔oracle room. Per-turn a `byo:`-namespaced model id swaps a request-scoped LLM adapter into ambient so the main agent and every sub-agent role run on the user's credential; credits are skipped on BYO turns. Includes the `/byo-llm/*` connect surface (status, device flow, code exchange, API-key save, validate, disconnect), cross-provider reasoning-history sanitation, Responses-API stream handling in the SSE runner, `encryptJWE` + `SecretsService.putSecret` for server-side secret writes, and a `getChatAnthropicModel` factory.

### Patch Changes

- Updated dependencies [[`b6cd393`](https://github.com/ixoworld/qiforge/commit/b6cd393e52c9e375189d1d3e9900f4b5f5cf571d), [`cf21fba`](https://github.com/ixoworld/qiforge/commit/cf21fbab90d7b1e50fdd7d238ecc05375c25f8b4)]:
  - @ixo/oracles-chain-client@2.2.0
  - @ixo/matrix@1.3.0

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

### Patch Changes

- Updated dependencies [[`2a3bbd3`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/2a3bbd3267e1ce9a413eba4a30757e92ee8fa87b)]:
  - @ixo/matrix@1.1.0

## 1.0.2

### Patch Changes

- [#53](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/53) [`0a4a5a8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/0a4a5a84194acb851e3824e0b74eea54f60c8257) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Upgrade packages and publish events package and preformance upgrades

- Updated dependencies [[`b723472`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/b72347286054e037436a8be3da3cf840f75223ca), [`0a4a5a8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/0a4a5a84194acb851e3824e0b74eea54f60c8257)]:
  - @ixo/matrix@1.0.2

## 1.0.1

### Patch Changes

- [#44](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/44) [`2b93cf8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/2b93cf8ef3839c36f03249b9392606211a22a0db) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - use matrix spaces and reduce using user mx token

- Updated dependencies [[`2b93cf8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/2b93cf8ef3839c36f03249b9392606211a22a0db)]:
  - @ixo/matrix@1.0.1
