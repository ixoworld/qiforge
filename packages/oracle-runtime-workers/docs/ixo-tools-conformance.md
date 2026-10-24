# Run IXO client conformance

Build the workspace dependencies and run the checked-in gate from the repository root.

```sh
pnpm install --frozen-lockfile
pnpm --filter @ixo/agent-tools --filter @ixo/agent-tools-sources --filter @ixo/ucan --filter '@ixo/common...' --filter '@ixo/ixo-transaction...' build
pnpm --filter @ixo/oracle-runtime-workers test:ixo-conformance
```

Read `packages/oracle-runtime-workers/artifacts/ixo-conformance-report.json`. The command exits 1 if any required test, comparison, installed version or source digest is missing or fails. It does not treat skipped tests as passes. CI uploads this report even when the gate fails.

To choose an output file, run the driver from the runtime package.

```sh
node scripts/verify-ixo-conformance.mjs --output /tmp/ixo-conformance.json
```

To require hosted acceptance, add `--require-hosted`. A passing local gate exits 3 while hosted evidence is absent. The driver does not ingest self-attested hosted results or provision credentials.

The seven local workerd suites exercise the real native plugin, official SDK client and patched LangChain adapter with synthetic source data and fixture introspection. The thirty tool comparisons cover all ten tools through each client. Other scenarios cover source outage versus zero, current authority, shared disclosure, memory provenance, strict inputs, reconnect, terminal enumeration and client cancellation. The report retains observed test names and outcomes, paired value/provenance digests, source-call counts, actual negotiated protocols, installed versions, patch/source hashes and Git revision/dirty state. Raw credentials and private payloads are excluded.

The catalog is a single terminal page. Any supplied discovery cursor is invalid. File search retains bounded coverage and rejects invented page controls. No file continuation or resumable transport session is added.

Read the cancellation limits in [IXO Tools MCP ingress](ixo-tools-mcp.md#cancellation-and-deadlines). The client cancellation cases require an abort rejection within two seconds, rather than accepting the thirty-second server deadline. A cancellation notification on another POST cannot address a prior request-local server. These tests do not establish hosted disconnect propagation or termination of already dispatched service work. The Worker-entry tests use controlled owner RPC separately from the real owner-storage tests.

Run the additional composed proof for real local Auth Hub/D1 and cryptographically verified downstream UCANs.

```sh
node test/ixo-mcp-composed/run.mjs /absolute/path/to/ixo-auth-worker /tmp/ixo-composed.json
```

Keep that proof separate from the client matrix. Its subscription balance and native/audience readers are controlled fixtures. It does not exercise the complete hosted Worker-to-owner route.

ChatGPT, Claude, the currently installed Companion, deployed sources, hosted Matrix membership and actual model journeys remain `NOT_RUN`. A local PASS leaves release `NOT_ESTABLISHED`. Companion's existing package pin remains unchanged. No merge, deployment, hosted migration, resource registration, npm publication or capsule upload is part of this gate.
