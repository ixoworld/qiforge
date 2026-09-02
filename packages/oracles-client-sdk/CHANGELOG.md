# @ixo/oracles-client-sdk

## 1.3.7

### Patch Changes

- Updated dependencies [[`b6cd393`](https://github.com/ixoworld/qiforge/commit/b6cd393e52c9e375189d1d3e9900f4b5f5cf571d)]:
  - @ixo/oracles-chain-client@2.2.0

## 1.0.11

### Patch Changes

- [`c643779`](https://github.com/ixoworld/companion/commit/c6437794acd28c833074763449502daf61e40a4c) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - matrix fix

- Updated dependencies [[`c643779`](https://github.com/ixoworld/companion/commit/c6437794acd28c833074763449502daf61e40a4c)]:
  - @ixo/oracles-chain-client@1.1.3

## 1.0.10

### Patch Changes

- [`b5799ee`](https://github.com/ixoworld/companion/commit/b5799ee19a0957ad38e2374ae18e11278295a1ab) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Fix testnet signed mnemonics

- Updated dependencies [[`b5799ee`](https://github.com/ixoworld/companion/commit/b5799ee19a0957ad38e2374ae18e11278295a1ab)]:
  - @ixo/oracles-chain-client@1.1.2

## 1.0.9

### Patch Changes

- Updated dependencies [[`3117e8d`](https://github.com/ixoworld/companion/commit/3117e8d2f753811511de4eda8e99b18c3888e083)]:
  - @ixo/oracles-chain-client@1.1.1

## 0.2.0

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
  - @ixo/oracles-chain-client@1.1.0

## 0.1.23

### Patch Changes

- [`b723472`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/b72347286054e037436a8be3da3cf840f75223ca) Thanks [@yousefhany77](https://github.com/yousefhany77)! - fix bugs and some preformace updates

- [#53](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/53) [`0a4a5a8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/0a4a5a84194acb851e3824e0b74eea54f60c8257) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Upgrade packages and publish events package and preformance upgrades

- Updated dependencies [[`b723472`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/b72347286054e037436a8be3da3cf840f75223ca), [`0a4a5a8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/0a4a5a84194acb851e3824e0b74eea54f60c8257)]:
  - @ixo/oracles-chain-client@1.0.15
  - @ixo/oracles-events@1.0.1

## 0.1.19

### Patch Changes

- [#48](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/48) [`0664938`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/06649385d7a4d9f3640fb21a316f18c61f94e185) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Add support for overriding WS url and support to invite user to mx room

## 0.1.16

### Patch Changes

- [#44](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/44) [`2b93cf8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/2b93cf8ef3839c36f03249b9392606211a22a0db) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - use matrix spaces and reduce using user mx token

- Updated dependencies [[`2b93cf8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/2b93cf8ef3839c36f03249b9392606211a22a0db)]:
  - @ixo/oracles-chain-client@1.0.13

## 0.1.15

### Patch Changes

- [#42](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/42) [`27ddf3b`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/27ddf3b04d70604f856a55f537599626266c54b6) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - support metadata in chat

## 0.1.14

### Patch Changes

- [#40](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/40) [`78ddd3b`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/78ddd3b407dde28b7f6ca16c91ee7452f5491d73) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - enhance useChat and useOracleSessions hooks for improved performance and query handling

## 0.1.13

### Patch Changes

- [#38](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/38) [`e4c8f86`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/e4c8f866f6a51716e0c2074c9fe54d76beb4e92f) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - refactor: update Authz and Payments classes to improve authorization handling and integrate new settings resource utility

- Updated dependencies [[`e4c8f86`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/e4c8f866f6a51716e0c2074c9fe54d76beb4e92f)]:
  - @ixo/oracles-chain-client@1.0.12

## 0.1.12

### Patch Changes

- [#35](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/35) [`da24aae`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/da24aae97260c4fa186d3a2cc8f797c731d9cb98) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Fix for Using with FE React

- Updated dependencies [[`da24aae`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/da24aae97260c4fa186d3a2cc8f797c731d9cb98)]:
  - @ixo/oracles-chain-client@1.0.11

## 0.1.11

### Patch Changes

- [#33](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/33) [`c56f5c0`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/c56f5c0aff5867e300a7008c480bd76abd68557e) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - fix make package public

- Updated dependencies [[`c56f5c0`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/c56f5c0aff5867e300a7008c480bd76abd68557e)]:
  - @ixo/oracles-chain-client@1.0.10

## 0.1.10

### Patch Changes

- [#31](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/31) [`4b91a61`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/4b91a6140fba5d25d406a32e4254fcc2433cd391) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Make package public

## 0.1.9

### Patch Changes

- [#29](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/29) [`267de8c`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/267de8c8065387f69ae882920e101331fb93d2dd) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Update interfacesand small fixes for FE clients

- Updated dependencies [[`267de8c`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/267de8c8065387f69ae882920e101331fb93d2dd)]:
  - @ixo/oracles-chain-client@1.0.9

## 0.1.8

### Patch Changes

- [`edc19e3`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/edc19e39da21347af70f71432b297a6bfb135435) Thanks [@LukePetzer-ixo](https://github.com/LukePetzer-ixo)! - bump

- Updated dependencies [[`edc19e3`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/edc19e39da21347af70f71432b297a6bfb135435)]:
  - @ixo/oracles-chain-client@1.0.8

## 0.1.7

### Patch Changes

- [`bdff5e0`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/bdff5e0fdee1b52bbdd84f6c68d6cd6679b9c05d) Thanks [@LukePetzer-ixo](https://github.com/LukePetzer-ixo)! - Dockerfile

- Updated dependencies [[`bdff5e0`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/bdff5e0fdee1b52bbdd84f6c68d6cd6679b9c05d)]:
  - @ixo/oracles-chain-client@1.0.7

## 0.1.6

### Patch Changes

- [`6505d49`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/6505d4907e0a0f27656a72e5f334cfeba08a22b9) Thanks [@LukePetzer-ixo](https://github.com/LukePetzer-ixo)! - bump

- Updated dependencies [[`6505d49`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/6505d4907e0a0f27656a72e5f334cfeba08a22b9)]:
  - @ixo/oracles-chain-client@1.0.6

## 0.1.5

### Patch Changes

- [`c050676`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/c050676976a8f2bf90d9ecc55be115614639c253) Thanks [@LukePetzer-ixo](https://github.com/LukePetzer-ixo)! - bump

- Updated dependencies [[`c050676`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/c050676976a8f2bf90d9ecc55be115614639c253)]:
  - @ixo/oracles-chain-client@1.0.5

## 0.1.4

### Patch Changes

- [`53d6155`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/53d61558d5054d74288b38d4af47a60d15a066a6) Thanks [@LukePetzer-ixo](https://github.com/LukePetzer-ixo)! - bump

- Updated dependencies [[`53d6155`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/53d61558d5054d74288b38d4af47a60d15a066a6)]:
  - @ixo/oracles-chain-client@1.0.4

## 0.1.3

### Patch Changes

- [`b877474`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/b877474ee6d45e211212df15fbea337b338b8850) Thanks [@LukePetzer-ixo](https://github.com/LukePetzer-ixo)! - bump

- Updated dependencies [[`b877474`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/b877474ee6d45e211212df15fbea337b338b8850)]:
  - @ixo/oracles-chain-client@1.0.3

## 0.1.2

### Patch Changes

- [`26d8444`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/26d84448ac92b038df0330758f978d6be352b115) Thanks [@LukePetzer-ixo](https://github.com/LukePetzer-ixo)! - bump

- Updated dependencies [[`26d8444`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/26d84448ac92b038df0330758f978d6be352b115)]:
  - @ixo/oracles-chain-client@1.0.2

## 0.1.1

### Patch Changes

- [#16](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/16) [`745991a`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/745991a3fc7fb9ac640dc6fd2aad5a17781df9b7) Thanks [@LukePetzer-ixo](https://github.com/LukePetzer-ixo)! - Init

- Updated dependencies [[`745991a`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/745991a3fc7fb9ac640dc6fd2aad5a17781df9b7)]:
  - @ixo/oracles-chain-client@1.0.1
