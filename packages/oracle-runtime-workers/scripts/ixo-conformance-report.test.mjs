import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateConformance,
  SUITES,
  CLIENTS,
  TOOLS,
  SCENARIOS,
  REQUIRED_REGRESSIONS,
} from './ixo-conformance-report.mjs';

const version = '2025-11-25';
const hash = 'a'.repeat(64);
function fixture() {
  const suites = SUITES.map((file) => ({
    name: `/checkout/test/${file}`,
    assertionResults: [],
  }));
  for (const client of CLIENTS) {
    for (const tool of TOOLS) {
      suites[0].assertionResults.push({
        fullName: `IXO conformance ${client} preserves ${tool} domain value and provenance`,
        status: 'passed',
      });
    }
    for (const scenario of SCENARIOS) {
      suites[0].assertionResults.push({
        fullName: `IXO conformance ${client} ${scenario}`,
        status: 'passed',
      });
    }
  }
  for (const [index, count] of [14, 56, 10, 14, 6, 3].entries()) {
    for (let number = 0; number < count; number++) {
      suites[index + 1].assertionResults.push({
        fullName:
          REQUIRED_REGRESSIONS[SUITES[index + 1]]?.[number] ??
          `required regression ${number}`,
        status: 'passed',
      });
    }
  }
  const observations = CLIENTS.flatMap((client) =>
    TOOLS.map((tool) => ({
      client,
      tool,
      protocol: client === 'native-plugin' ? null : version,
      sourceCallCount: 1,
      comparison: 'equal',
      expectedDomainDigest: hash,
      observedDomainDigest: hash,
      expectedEvidenceDigest: hash,
      observedEvidenceDigest: hash,
    })),
  );
  return {
    vitest: { testResults: suites },
    observations,
    supportedProtocols: [version],
    catalogNames: TOOLS,
  };
}
const evaluate = (data) => evaluateConformance(data);

test('accepts a complete observed suite and thirty paired value and provenance rows', () => {
  const result = evaluate(fixture());
  assert.equal(result.status, 'PASS');
  assert.equal(result.rows.length, 30);
  assert.equal(result.tests.length, 163);
});

test('rejects missing, skipped, failed, duplicated and misassigned matrix tests', () => {
  const changes = [
    (data) => data.vitest.testResults[0].assertionResults.pop(),
    (data) => {
      data.vitest.testResults[0].assertionResults[0].status = 'pending';
    },
    (data) => {
      data.vitest.testResults[0].assertionResults[0].status = 'failed';
    },
    (data) =>
      data.vitest.testResults[0].assertionResults.push({
        ...data.vitest.testResults[0].assertionResults[0],
      }),
    (data) => {
      data.vitest.testResults[0].assertionResults[0].fullName =
        'IXO conformance official-sdk preserves ixo_account_get domain value and provenance';
    },
  ];
  for (const change of changes) {
    const data = fixture();
    change(data);
    assert.equal(evaluate(data).status, 'FAIL');
  }
});

test('rejects missing, duplicated, changed-value and swapped-provenance observations', () => {
  const changes = [
    (data) => data.observations.pop(),
    (data) => data.observations.push({ ...data.observations[0] }),
    (data) => {
      data.observations[0].observedDomainDigest = 'b'.repeat(64);
    },
    (data) => {
      data.observations[0].observedEvidenceDigest = 'b'.repeat(64);
    },
    (data) => {
      data.observations[0].comparison = 'different';
    },
    (data) => {
      data.observations[0].tool = 'ixo_credits_get';
    },
  ];
  for (const change of changes) {
    const data = fixture();
    change(data);
    assert.equal(evaluate(data).status, 'FAIL');
  }
});

test('rejects missing lifecycle suite and unsupported or inconsistent negotiated versions', () => {
  const missing = fixture();
  missing.vitest.testResults.splice(1, 1);
  assert.equal(evaluate(missing).status, 'FAIL');
  const incomplete = fixture();
  incomplete.vitest.testResults[3].assertionResults.pop();
  assert.equal(evaluate(incomplete).status, 'FAIL');
  const unsupported = fixture();
  unsupported.observations[10].protocol = '1900-01-01';
  assert.equal(evaluate(unsupported).status, 'FAIL');
  const inconsistent = fixture();
  inconsistent.observations[10].protocol = null;
  assert.equal(evaluate(inconsistent).status, 'FAIL');
});

test('rejects deleting lifecycle cancellation and replacing a named regression with an unrelated pass', () => {
  const deleted = fixture();
  deleted.vitest.testResults[1].assertionResults =
    deleted.vitest.testResults[1].assertionResults.slice(0, 2);
  assert.equal(evaluate(deleted).status, 'FAIL');
  for (const file of Object.keys(REQUIRED_REGRESSIONS)) {
    const data = fixture();
    const suite = data.vitest.testResults.find((suite) =>
      suite.name.endsWith(file),
    );
    suite.assertionResults[0].fullName = 'unrelated replacement test';
    assert.equal(evaluate(data).status, 'FAIL');
  }
});
