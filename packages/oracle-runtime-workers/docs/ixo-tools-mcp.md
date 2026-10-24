# IXO Tools MCP ingress

The optional MCP ingress exposes the existing IXO read-tool surface to registered OAuth clients. It remains disabled unless the oracle operator supplies `createOracleWorker({ ixoToolsMcp: ... })` and binds `IXO_MCP_RESOURCE_CLIENT_SECRET` separately. No deployment configuration enables it in this change.

## Configure an exact resource

```ts
ixoToolsMcp: {
  resource: 'https://oracle.example/v1/mcp',
  issuer: 'https://auth.example',
  resourceClientId: 'oracle-resource-client',
  clients: [{
    clientId: 'approved-ai-client',
    disclosure: 'shared',
    timezone: 'UTC',
    origins: ['https://approved-app.example'],
  }],
}
```

The resource must be a canonical HTTPS URL with the exact `/v1/mcp` path. The issuer must be an exact HTTPS origin without a trailing slash. Neither URL accepts credentials, query parameters or fragments. Client IDs are unique. Omitted client disclosure, timezone and origins default to `shared`, `UTC` and an empty browser-origin allowlist. An empty allowlist permits clients that send no Origin header. It permits no browser Origin.

Auth Hub must independently register this exact resource, its dedicated confidential introspection client and each allowed OAuth client. Runtime configuration cannot create or change those registrations. The `ixo:tools:read` scope only narrows current native IXO grants. It creates no native grant.

## Authentication and current authority

Every request authenticates its Bearer access token through `POST <issuer>/oauth/introspect`. The runtime authenticates that backchannel with the dedicated resource client's Basic credentials. The token and resource secret are used only for this fixed backchannel. Redirects are rejected. Fetch and streamed body consumption share a five-second deadline. The JSON response is limited to 16 KiB and validated as a closed schema.

An active result must bind issuer, exact resource audience, DID subject, approved OAuth client, grant ID, opaque grant generation, required scope, issue time, expiry, token ID and Bearer token type. Introspection has no positive cache. Each current-authority check freshly introspects and compares the complete binding and client policy. The response is withheld if the final check fails, including initialization and tool discovery responses.

Worker routing authenticates the subject before selecting its owner Durable Object. The owner authenticates the original request again and constructs the existing shared surface from current native delegation and host-owned context. Requests cannot provide a user, session, oracle, service origin or downstream grant through headers or tool arguments. Downstream invocations remain separately minted, audience-specific native UCANs.

Client disclosure defaults to shared. Private disclosure requires explicit operator configuration and positive current membership evidence in the owner implementation. It does not attest the privacy of a third-party client's conversation. Bearers are not sender-constrained. A stolen token presented under its original client claim cannot be distinguished from its legitimate presenter by this design.

## Supported protocol

The ingress uses the pinned official MCP SDK 1.30.0 `Server` and `WebStandardStreamableHTTPServerTransport`. Every POST gets a fresh server and JSON-response transport. Initialization negotiates a supported protocol version. Initialized notifications return 202. Tools/list filters the canonical MCP descriptors through current native discovery. Tools/call invokes those same shared handlers and returns their typed result in both text and `structuredContent`.

The endpoint supports POST and a bounded unauthenticated OPTIONS preflight. It rejects incoming MCP session IDs, unsupported protocol-version headers, unapproved browser origins, non-JSON content and JSON bodies above 64 KiB. GET event streams, transport sessions, event replay and DELETE session termination are unsupported. The SDK still validates JSON-RPC envelopes and advertised Accept types.

Protected-resource metadata is available at `/.well-known/oauth-protected-resource/v1/mcp`. Unauthorized responses include its URL in the Bearer challenge. Responses use no-store. CORS permits only configured exact origins and exposes the challenge and protocol-version headers. Internal source exceptions and credentials are not returned to clients.

## Verification and activation limits

Run `pnpm --filter @ixo/oracle-runtime-workers exec vitest run test/ixo-mcp-protocol.test.ts` for actual workerd SDK, introspection, protocol, denial and timeout tests. The authority suite constructs the real owner class inside actual Durable Object storage and separately checks Worker routing. The intent suite sends all ten read tools through MCP and the existing source adapters. Those service responses are controlled fixtures.

Passing local tests does not establish hosted Auth Hub registration, live OAuth consent, installed Companion support, production membership evidence or deployed source compatibility. Those remain activation gates. This change does not merge, deploy or publish any runtime.

The portable cross-repository proof in `test/ixo-mcp-composed/README.md` runs the real Auth Hub application and migrations beside the MCP handler, shared source adapters and a subscriptions fixture that cryptographically verifies downstream UCANs. It uses controlled native delegation and disclosure readers. It does not traverse the deployed Worker-to-object RPC path or live Matrix membership.

The non-chat MCP context has no chat history or attachment access. File search can still read authorized VFS metadata, but reports incomplete attachment coverage and cannot conclude that an upload is absent from chat. Ordinary and VFS invocations carry an absolute expiry ceiling bounded by both OAuth and native authority, as well as the sixty-second cap.

Auth Hub migration 0030 invalidates existing authorization codes and refresh tokens across legacy OAuth resources. Its release requires a planned client reauthorization. Deployment and credential provisioning remain separate approval gates.
