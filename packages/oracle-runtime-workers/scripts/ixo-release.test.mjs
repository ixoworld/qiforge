import { URL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import {
  assessRelease,
  receiptDigest,
  candidateSchema,
  CAPSULES,
  REQUIRED_CASES,
  digest,
  NETWORKS,
} from './ixo-release.mjs';
import {
  TOOLS,
  SOURCE_PATHS,
  CLIENTS,
  SUITES,
  SCENARIOS,
  REQUIRED_REGRESSIONS,
  evaluateConformance,
} from './ixo-conformance-report.mjs';

const h = 'a'.repeat(64);
const c = 'b'.repeat(40);
const now = Date.parse('2026-10-24T17:00:00Z');
function fixture() {
  const candidate = candidateSchema.parse({
    schemaVersion: 1,
    gateVersion: 1,
    gateSha256: h,
    components: Object.fromEntries(
      [
        'qiforge',
        'companion',
        'authHub',
        'subscriptions',
        'memory',
        'vfs',
        'yellowcard',
        'knowledge',
      ].map((name) => [name, c]),
    ),
    runtime: { version: '0.22.0', sha256: h },
    catalog: { version: '2.0.0', sha256: h },
    model: { id: 'fixture-provider-model', promptSha256: h },
    modules: TOOLS,
    capsules: CAPSULES.map((id) => ({
      id,
      authorCommit: c,
      cid: `Qm${'a'.repeat(44)}`,
      archiveSha256: h,
      rollbackCid: `Qm${'b'.repeat(44)}`,
    })),
    networks: Object.fromEntries(
      NETWORKS.map((n) => [
        n,
        {
          resource: `https://${n}.example.org/v1/mcp`,
          clientIds: ['fixture-client'],
          rollback: {
            companionCommit: c,
            runtimeCommit: c,
            oracleVersion: 'prior-oracle',
            gatewayVersion: 'prior-gateway',
            configSha256: h,
            authPolicyRevision: 'prior-policy',
          },
        },
      ]),
    ),
  });
  const suites = SUITES.map((name) => ({ name, assertionResults: [] }));
  for (const client of CLIENTS) {
    for (const tool of TOOLS)
      suites[0].assertionResults.push({
        fullName: `IXO conformance ${client} preserves ${tool} domain value and provenance`,
        status: 'passed',
      });
    for (const scenario of SCENARIOS)
      suites[0].assertionResults.push({
        fullName: `IXO conformance ${client} ${scenario}`,
        status: 'passed',
      });
  }
  for (const [i, count] of [14, 56, 10, 14, 6, 3].entries())
    for (let j = 0; j < count; j++) {
      suites[i + 1].assertionResults.push({
        fullName: REQUIRED_REGRESSIONS[SUITES[i + 1]]?.[j] ?? `baseline ${j}`,
        status: 'passed',
      });
    }
  const observations = CLIENTS.flatMap((client) =>
    TOOLS.map((tool) => ({
      client,
      tool,
      protocol: client === 'native-plugin' ? null : '2025-11-25',
      sourceCallCount: 1,
      comparison: 'equal',
      expectedDomainDigest: h,
      observedDomainDigest: h,
      expectedEvidenceDigest: h,
      observedEvidenceDigest: h,
    })),
  );
  const digests = Object.fromEntries(SOURCE_PATHS.map((path) => [path, h]));
  const report = {
    generatedAt: new Date(now).toISOString(),
    git: { head: c, dirty: false },
    sourceDigests: digests,
    local: evaluateConformance({
      vitest: { testResults: suites },
      observations,
      supportedProtocols: ['2025-11-25'],
      catalogNames: TOOLS,
    }),
  };
  assert.equal(report.local.status, 'PASS');
  const artifacts = new Map();
  function put(path, bytes) {
    bytes = Buffer.from(bytes);
    artifacts.set(path, bytes);
    return { path, sha256: digest(bytes) };
  }
  const trace = put(
    'private/trace.sse',
    'synthetic fixture trace, never live acceptance',
  );
  const attestation = { path: 'private/review.json', sha256: h };
  const evidence = {
    schemaVersion: 1,
    localConformance: put('local.json', JSON.stringify(report)),
    receipts: NETWORKS.flatMap((n, i) =>
      Object.entries(REQUIRED_CASES).map(([gate, cases], gateIndex) => ({
        gate,
        network: n,
        candidateSha256: digest(JSON.stringify(candidate)),
        kind: 'hosted',
        observedAt: new Date(
          now - (3 - i) * 60_000 + gateIndex * 2000,
        ).toISOString(),
        subject: {
          oracleVersion: 'new-oracle',
          gatewayVersion: 'new-gateway',
          configSha256: h,
          modelId: candidate.model.id,
          promptSha256: h,
          runtimeSha256: h,
          catalogSha256: h,
          resource: candidate.networks[n].resource,
          clientIds: ['fixture-client'],
          modules: TOOLS,
        },
        cases: cases.map((id) => ({ id, result: 'PASS', artifacts: [trace] })),
        review: {
          collector: 'fixture-collector',
          reviewer: 'fixture-reviewer',
          reviewedAt: new Date(
            now - (3 - i) * 60_000 + gateIndex * 2000 + 1000,
          ).toISOString(),
          decision: 'ACCEPT',
          attestation,
        },
      })),
    ),
  };
  for (const receipt of evidence.receipts) {
    receipt.review.attestation = put(
      `private/${receipt.network}-${receipt.gate}-review.json`,
      JSON.stringify({
        schemaVersion: 1,
        receiptSha256: receiptDigest(receipt),
        reviewer: receipt.review.reviewer,
        decision: 'ACCEPT',
      }),
    );
  }
  return {
    candidate,
    evidence,
    artifacts,
    source: { head: c, dirty: false, digests },
    gateSha256: h,
    network: 'mainnet',
    now,
  };
}
const assess = (data) => assessRelease(data);
function blocked(change, code) {
  const data = fixture();
  change(data);
  const report = assess(data);
  assert.equal(report.assessment, 'INCOMPLETE');
  assert.ok(
    report.blockers.some((s) => s.startsWith(code)),
    JSON.stringify(report.blockers),
  );
  assert.equal(report.deploymentAuthorized, false);
}

test('complete synthetic records mean review only and never deployment or release acceptance', () => {
  const result = assess(fixture());
  assert.equal(result.assessment, 'RECORDS_COMPLETE_FOR_REVIEW');
  assert.equal(result.deploymentAuthorized, false);
  assert.equal(result.release, 'NOT_ESTABLISHED');
});

test('an empty evidence bundle identifies every missing network gate', () => {
  const data = fixture();
  data.evidence = { schemaVersion: 1, localConformance: null, receipts: [] };
  const result = assess(data);
  assert.equal(
    result.blockers.filter((s) => s.startsWith('gate_missing')).length,
    24,
  );
  assert.ok(result.blockers.includes('local_conformance_missing'));
});

test('fixture, incomplete, duplicate, omitted and swapped case evidence cannot pass', () => {
  blocked((d) => {
    d.evidence.receipts[0].kind = 'fixture';
  }, 'fixture_not_hosted');
  blocked((d) => {
    d.evidence.receipts[0].cases[0].result = 'NOT_RUN';
  }, 'case_not_accepted');
  blocked((d) => {
    d.evidence.receipts.push(d.evidence.receipts[0]);
  }, 'duplicate_gate');
  blocked((d) => {
    d.evidence.receipts[0].cases.pop();
  }, 'case_set_mismatch');
  blocked((d) => {
    d.evidence.receipts[0].cases[0].id = d.evidence.receipts[0].cases[1].id;
  }, 'case_set_mismatch');
});

test('wrong user-oracle journey coverage cannot be replaced by aggregate success', () => {
  blocked((d) => {
    d.evidence.receipts.find((r) => r.gate === 'agent').cases[0].id =
      'user-b/oracle-b/account';
  }, 'case_set_mismatch');
});

test('changed, missing and swapped raw artifacts or attestations cannot pass', () => {
  blocked(
    (d) => d.artifacts.set('private/trace.sse', Buffer.from('changed')),
    'artifact_missing_or_changed',
  );
  blocked(
    (d) => d.artifacts.delete('private/devnet-baseline-review.json'),
    'artifact_missing_or_changed',
  );
  blocked((d) => {
    d.evidence.receipts[0].cases[0].artifacts[0].path = 'local.json';
  }, 'artifact_missing_or_changed');
});

test('review attestations bind the exact receipt and refuse arbitrary or reused bytes', () => {
  blocked((d) => {
    const receipt = d.evidence.receipts[0];
    const bytes = Buffer.from('{}');
    d.artifacts.set(receipt.review.attestation.path, bytes);
    receipt.review.attestation.sha256 = digest(bytes);
  }, 'attestation_mismatch');
  blocked((d) => {
    d.evidence.receipts[0].review.attestation =
      d.evidence.receipts[1].review.attestation;
  }, 'attestation_mismatch');
});

test('falsy and primitive local JSON cannot bypass source and conformance checks', () => {
  for (const value of [false, 0, '', null, true, [], {}]) {
    const d = fixture();
    const bytes = Buffer.from(JSON.stringify(value));
    d.artifacts.set('local.json', bytes);
    d.evidence.localConformance.sha256 = digest(bytes);
    d.source = { head: 'wrong', dirty: true, digests: {} };
    assert.throws(() => assess(d));
  }
});

test('equivalent canonical resource URLs cannot stand in for three networks', () => {
  blocked((d) => {
    d.candidate.networks.devnet.resource = 'https://release.example.org/v1/mcp';
    d.candidate.networks.testnet.resource =
      'https://RELEASE.example.org/v1/mcp';
    d.candidate.networks.mainnet.resource =
      'https://release.example.org:443/v1/mcp';
  }, 'network_resource_reused');
});

test('candidate, gate and deployed subject drift invalidates records', () => {
  blocked((d) => {
    d.candidate.model.id = 'changed-model';
  }, 'candidate_mismatch');
  blocked((d) => {
    d.gateSha256 = 'c'.repeat(64);
  }, 'gate_digest_mismatch');
  blocked((d) => {
    d.evidence.receipts[0].subject.promptSha256 = 'c'.repeat(64);
  }, 'subject_mismatch');
  blocked((d) => {
    d.evidence.receipts[0].subject.resource =
      d.candidate.networks.testnet.resource;
  }, 'subject_mismatch');
  blocked((d) => {
    d.evidence.receipts[0].subject.oracleVersion = 'different';
  }, 'deployed_version_mismatch');
});

test('missing capsule or module and duplicate client bindings cannot pass', () => {
  blocked((d) => d.candidate.modules.pop(), 'module_set_mismatch');
  blocked((d) => d.candidate.capsules.pop(), 'capsule_set_mismatch');
  blocked(
    (d) => d.candidate.networks.devnet.clientIds.push('fixture-client'),
    'duplicate_client',
  );
});

test('operator self-review, pending decisions, future and stale evidence cannot pass', () => {
  blocked((d) => {
    d.evidence.receipts[0].review.reviewer = 'fixture-collector';
  }, 'review_missing');
  blocked((d) => {
    d.evidence.receipts[0].review.decision = 'PENDING';
  }, 'review_missing');
  blocked((d) => {
    d.now += 86_400_001;
  }, 'stale_or_unordered_review');
  blocked((d) => {
    d.now -= 86_400_001;
  }, 'stale_or_unordered_review');
});

test('testnet and mainnet require previous accepted canaries in temporal order', () => {
  blocked((d) => {
    d.evidence.receipts = d.evidence.receipts.filter(
      (r) => r.network !== 'devnet',
    );
  }, 'gate_missing:devnet');
  blocked((d) => {
    d.evidence.receipts.find(
      (r) => r.network === 'devnet' && r.gate === 'canary',
    ).review.reviewedAt = new Date(now).toISOString();
  }, 'network_order:testnet');
});

test('all environment gates follow baseline review and precede the accepted canary', () => {
  blocked((d) => {
    const r = d.evidence.receipts.find(
      (r) => r.network === 'devnet' && r.gate === 'services',
    );
    r.observedAt = new Date(now - 1000).toISOString();
    r.review.reviewedAt = new Date(now).toISOString();
  }, 'canary_order:devnet');
  blocked((d) => {
    const r = d.evidence.receipts.find(
      (r) => r.network === 'mainnet' && r.gate === 'clients',
    );
    r.observedAt = new Date(now - 200_000).toISOString();
    r.review.reviewedAt = new Date(now - 199_000).toISOString();
  }, 'baseline_order:mainnet');
});

test('local reports are rerun through critical regression and pairing policy, not their PASS string', () => {
  const mutate = (change) => (d) => {
    const r = JSON.parse(d.artifacts.get('local.json'));
    change(r);
    const bytes = Buffer.from(JSON.stringify(r));
    d.artifacts.set('local.json', bytes);
    d.evidence.localConformance.sha256 = digest(bytes);
  };
  blocked(
    mutate((r) => r.local.tests.pop()),
    'local_conformance_incomplete',
  );
  blocked(
    mutate((r) => {
      r.local.rows[0].observedDomainDigest = 'c'.repeat(64);
    }),
    'local_conformance_incomplete',
  );
  blocked(
    mutate((r) => {
      r.git.dirty = true;
    }),
    'local_source_mismatch',
  );
  blocked((d) => {
    d.source.digests[SOURCE_PATHS[0]] = 'c'.repeat(64);
  }, 'local_source_digest_mismatch');
});

test('strict schemas reject approval switches, payment modules and missing rollback identity', () => {
  for (const change of [
    (d) => {
      d.candidate.approved = true;
    },
    (d) => d.candidate.modules.push('ixo_payment_execute'),
    (d) => {
      delete d.candidate.networks.mainnet.rollback.gatewayVersion;
    },
    (d) => {
      d.evidence.receipts[0].review.approved = true;
    },
  ]) {
    const data = fixture();
    change(data);
    assert.throws(() => assess(data));
  }
});

test('CLI returns incomplete/malformed separately and refuses symlink path escapes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ixo-release-'));
  try {
    const d = fixture();
    d.evidence.localConformance = null;
    d.evidence.receipts = [];
    await writeFile(join(dir, 'candidate.json'), JSON.stringify(d.candidate));
    await writeFile(join(dir, 'evidence.json'), JSON.stringify(d.evidence));
    const run = () =>
      spawnSync(
        process.execPath,
        [
          new URL('./check-ixo-release.mjs', import.meta.url).pathname,
          '--candidate',
          join(dir, 'candidate.json'),
          '--evidence',
          join(dir, 'evidence.json'),
          '--source',
          process.cwd(),
          '--network',
          'devnet',
        ],
        { encoding: 'utf8' },
      );
    const result = run();
    assert.equal(result.status, 3, result.stderr);
    assert.equal(JSON.parse(result.stdout).deploymentAuthorized, false);
    d.evidence.localConformance = { path: 'escape', sha256: h };
    await symlink('/etc/hosts', join(dir, 'escape'));
    await writeFile(join(dir, 'evidence.json'), JSON.stringify(d.evidence));
    assert.equal(run().status, 2);
    await writeFile(join(dir, 'candidate.json'), '{}');
    assert.equal(run().status, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
