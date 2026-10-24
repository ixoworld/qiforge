import { createHash } from 'node:crypto';

export const SUITES = [
  'ixo-client-conformance.test.ts',
  'ixo-mcp-lifecycle.test.ts',
  'ixo-mcp-protocol.test.ts',
  'ixo-mcp-authority.test.ts',
  'ixo-mcp-intents.test.ts',
  'ixo-tools-cancellation.test.ts',
  'ixo-mcp-worker.test.ts',
];
export const CLIENTS = ['native-plugin', 'official-sdk', 'langchain-adapter'];
export const TOOLS = [
  'ixo_account_get',
  'ixo_credits_get',
  'ixo_concept_get',
  'ixo_error_explain',
  'ixo_files_find',
  'ixo_offramp_options',
  'ixo_offramp_quote',
  'ixo_operation_get',
  'ixo_memory_personal_search',
  'ixo_memory_oracle_search',
];
export const SCENARIOS = [
  'enumerates only current descriptors and terminates without a cursor',
  'cancels the pending client call and discards its late result',
  'reconnects without a transport session and rechecks the current grant',
  'preserves explicit partial file coverage without accepting invented page controls',
  'keeps personal and oracle memory receipts distinct',
  'preserves confirmed zero and source outage as distinct results',
  'refuses a cached descriptor after native authority is withdrawn',
  'does not expose private tools to a shared audience',
  'rejects owner and network overrides before source access',
  'rejects a changed domain value and swapped provenance assignment',
];
export const REQUIRED_REGRESSIONS = {
  'ixo-mcp-lifecycle.test.ts': [
    'IXO MCP lifecycle does no authorization or tool work for an already aborted request',
    'IXO MCP bounded requests and stateless recovery withholds a result when the observed HTTP request aborts during a read',
    'IXO MCP bounded requests and stateless recovery bounds a stalled surface factory and prevents its late discovery',
    'IXO MCP bounded requests and stateless recovery keeps a cancelled request isolated from a concurrent request with the same RPC ID',
    'IXO MCP bounded requests and stateless recovery accepts an unmatched cancellation notification without cancelling another POST',
  ],
  'ixo-mcp-worker.test.ts': [
    'IXO real Worker entry with controlled owner RPC bounds a held owner call and forwards an aborted request lifetime',
    'IXO real Worker entry with controlled owner RPC withholds a completed owner response when OAuth is revoked before Worker disclosure',
    'IXO real Worker entry with controlled owner RPC cancels a stalled owner response reader at the outer deadline',
  ],
  'ixo-tools-cancellation.test.ts': [
    'IXO native lifetime and source cancellation rejects before calling an already cancelled operation',
    'IXO native lifetime and source cancellation bounds a non-cooperative authority promise and ignores its late result',
    'IXO native lifetime and source cancellation cleans its deadline and listener when work finishes',
    'IXO native lifetime and source cancellation composes source Request signals without replacing existing timeouts',
    'IXO native lifetime and source cancellation propagates a cancelled native turn into the actual source fetch',
    'IXO native lifetime and source cancellation does not reuse a cancelled turn lifetime for another owner binding',
  ],
  'ixo-mcp-authority.test.ts': [
    'MCP owner scope and native authority rejects a pre-aborted Worker request before authentication or owner selection',
    'MCP owner scope and native authority does not select an owner when the Worker request aborts during introspection',
  ],
};
const MIN_TESTS = {
  'ixo-client-conformance.test.ts':
    CLIENTS.length * (TOOLS.length + SCENARIOS.length),
  'ixo-mcp-lifecycle.test.ts': 14,
  'ixo-mcp-protocol.test.ts': 56,
  'ixo-mcp-authority.test.ts': 10,
  'ixo-mcp-intents.test.ts': 14,
  'ixo-tools-cancellation.test.ts': 6,
  'ixo-mcp-worker.test.ts': 3,
};
const HEX = /^[a-f0-9]{64}$/;
const STATUSES = {
  passed: 'PASS',
  failed: 'FAIL',
  pending: 'NOT_RUN',
  skipped: 'NOT_RUN',
  todo: 'NOT_RUN',
};
const shortFile = (path) => String(path).split(/[\\/]/).at(-1);
const key = (file, name) => `${file}::${name}`;
const digest = (value) => createHash('sha256').update(value).digest('hex');

export const SOURCE_PATHS = [
  'packages/agent-tools/src/catalog.ts',
  'packages/agent-tools/src/host.ts',
  'packages/oracle-runtime-workers/src/ixo-tools/surface.ts',
  'packages/oracle-runtime-workers/src/ixo-tools/lifetime.ts',
  'packages/oracle-runtime-workers/src/ixo-tools/turn-host.ts',
  'packages/oracle-runtime-workers/src/ixo-tools/mcp/auth.ts',
  'packages/oracle-runtime-workers/src/ixo-tools/mcp/index.ts',
  'packages/oracle-runtime-workers/src/index.ts',
  'packages/oracle-runtime-workers/src/do/user-oracle-do.ts',
  'packages/oracle-runtime-workers/src/ixo-tools/mcp/protocol.ts',
  'packages/oracle-runtime-workers/src/do/ixo-mcp.ts',
  'packages/oracle-runtime-workers/src/plugins/ixo-tools/ixo-tools.plugin.ts',
  'patches/@langchain__mcp-adapters@1.1.4.patch',
  'pnpm-lock.yaml',
  'packages/oracle-runtime-workers/test/ixo-tools-fixtures.ts',
  'packages/oracle-runtime-workers/vitest.config.ts',
  'packages/oracle-runtime-workers/scripts/verify-ixo-conformance.mjs',
  'packages/oracle-runtime-workers/scripts/ixo-conformance-report.mjs',
  'packages/oracle-runtime-workers/scripts/ixo-conformance-report.test.mjs',
  'turbo.json',
  ...SUITES.map((file) => `packages/oracle-runtime-workers/test/${file}`),
];

export function evaluateConformance({
  vitest,
  observations,
  supportedProtocols,
  catalogNames,
}) {
  const issues = [];
  const suites = Array.isArray(vitest?.testResults) ? vitest.testResults : [];
  const observedRows = Array.isArray(observations) ? observations : [];
  const protocols = Array.isArray(supportedProtocols) ? supportedProtocols : [];
  if (
    !Array.isArray(catalogNames) ||
    catalogNames.length !== TOOLS.length ||
    new Set(catalogNames).size !== TOOLS.length ||
    TOOLS.some((tool) => !catalogNames.includes(tool))
  ) {
    issues.push('catalog_mismatch');
  }
  const tests = [];
  const seen = new Set();
  for (const suite of suites) {
    if (!suite || typeof suite !== 'object') {
      issues.push('invalid_suite_result');
      continue;
    }
    const file = shortFile(suite.name);
    if (!SUITES.includes(file)) continue;
    for (const assertion of Array.isArray(suite.assertionResults)
      ? suite.assertionResults
      : []) {
      if (!assertion || typeof assertion !== 'object') {
        issues.push(`invalid_test_result:${file}`);
        continue;
      }
      const name =
        assertion.fullName ??
        [...(assertion.ancestorTitles ?? []), assertion.title].join(' ');
      const id = key(file, name);
      if (seen.has(id)) issues.push(`duplicate_test:${digest(id)}`);
      seen.add(id);
      const status = STATUSES[assertion.status] ?? 'NOT_RUN';
      tests.push({ file, name, status });
      if (status !== 'PASS') issues.push(`test_not_passed:${digest(id)}`);
    }
  }
  for (const file of SUITES) {
    if (!tests.some((test) => test.file === file))
      issues.push(`missing_suite:${file}`);
    if (tests.filter((test) => test.file === file).length < MIN_TESTS[file])
      issues.push(`suite_below_baseline:${file}`);
  }
  for (const [file, names] of Object.entries(REQUIRED_REGRESSIONS)) {
    for (const name of names) {
      if (!seen.has(key(file, name)))
        issues.push(`missing_required_regression:${file}:${digest(name)}`);
    }
  }
  const matrix = [];
  for (const client of CLIENTS) {
    for (const tool of TOOLS) {
      const name = `IXO conformance ${client} preserves ${tool} domain value and provenance`;
      if (!seen.has(key(SUITES[0], name)))
        issues.push(`missing_matrix_test:${client}:${tool}`);
      matrix.push({ client, tool, name });
    }
    for (const scenario of SCENARIOS) {
      const name = `IXO conformance ${client} ${scenario}`;
      if (!seen.has(key(SUITES[0], name)))
        issues.push(`missing_scenario:${client}:${digest(scenario)}`);
    }
  }
  if (!Array.isArray(observations)) issues.push('observations_missing');
  const rowMap = new Map();
  for (const row of observedRows) {
    const id = `${row?.client}:${row?.tool}`;
    if (rowMap.has(id)) issues.push(`duplicate_observation:${digest(id)}`);
    rowMap.set(id, row);
    if (
      !matrix.some(
        (expected) =>
          expected.client === row?.client && expected.tool === row?.tool,
      )
    ) {
      issues.push(`unexpected_observation:${digest(id)}`);
    }
  }
  const rows = matrix.map(({ client, tool, name }) => {
    const row = rowMap.get(`${client}:${tool}`);
    const passed =
      tests.find((test) => test.file === SUITES[0] && test.name === name)
        ?.status === 'PASS';
    if (!row) issues.push(`missing_observation:${client}:${tool}`);
    const validComparison =
      row &&
      row.comparison === 'equal' &&
      Number.isSafeInteger(row.sourceCallCount) &&
      row.sourceCallCount >= 0 &&
      HEX.test(row.expectedDomainDigest) &&
      HEX.test(row.observedDomainDigest) &&
      HEX.test(row.expectedEvidenceDigest) &&
      HEX.test(row.observedEvidenceDigest) &&
      row.expectedDomainDigest === row.observedDomainDigest &&
      row.expectedEvidenceDigest === row.observedEvidenceDigest;
    if (row && !validComparison) {
      issues.push(`invalid_observation:${client}:${tool}`);
    }
    const validProtocol =
      row &&
      (client === 'native-plugin'
        ? row.protocol === null
        : typeof row.protocol === 'string' && protocols.includes(row.protocol));
    if (row && !validProtocol) {
      issues.push(`invalid_negotiated_protocol:${client}:${tool}`);
    }
    return {
      client,
      tool,
      status:
        passed && validComparison && validProtocol
          ? 'PASS'
          : row
            ? 'FAIL'
            : 'NOT_RUN',
      negotiatedProtocol: validProtocol ? row.protocol : null,
      sourceCallCount:
        Number.isSafeInteger(row?.sourceCallCount) && row.sourceCallCount >= 0
          ? row.sourceCallCount
          : null,
      expectedDomainDigest: HEX.test(row?.expectedDomainDigest)
        ? row.expectedDomainDigest
        : null,
      observedDomainDigest: HEX.test(row?.observedDomainDigest)
        ? row.observedDomainDigest
        : null,
      expectedEvidenceDigest: HEX.test(row?.expectedEvidenceDigest)
        ? row.expectedEvidenceDigest
        : null,
      observedEvidenceDigest: HEX.test(row?.observedEvidenceDigest)
        ? row.observedEvidenceDigest
        : null,
    };
  });
  for (const client of CLIENTS.filter((name) => name !== 'native-plugin')) {
    const versions = new Set(
      rows
        .filter((row) => row.client === client)
        .map((row) => row.negotiatedProtocol),
    );
    if (versions.size !== 1 || versions.has(null))
      issues.push(`inconsistent_negotiated_protocol:${client}`);
  }
  if (protocols.length === 0) issues.push('supported_protocols_missing');
  return {
    status: issues.length ? 'FAIL' : 'PASS',
    tests,
    rows,
    issues: [...new Set(issues)],
  };
}
