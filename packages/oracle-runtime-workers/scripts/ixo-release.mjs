import { URL } from 'node:url';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  TOOLS,
  SOURCE_PATHS,
  evaluateConformance,
} from './ixo-conformance-report.mjs';

export const NETWORKS = ['devnet', 'testnet', 'mainnet'];
export const CAPSULES = [
  'public:compose-topic',
  'public:error-resolver',
  'public:facilitate-topic',
  'public:ixo-jev-search',
  'public:ixo-yellowcard',
  'public:qi-library',
  'private:design-proposal',
  'private:invoice-creator',
  'private:ixo-artefact-library',
  'private:ixo-product-demo-video',
  'private:mcda',
  'private:recruitment-research',
];
export const digest = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const label = z.string().trim().min(1).max(200);
const timestamp = z.iso.datetime();
const network = z.enum(NETWORKS);
const https = z
  .url()
  .refine((s) => {
    const u = new URL(s);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      !u.hostname.endsWith('.invalid')
    );
  })
  .transform((s) => new URL(s).href);
const cid = z.string().regex(/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/);
const file = z.strictObject({
  path: z.string().regex(/^[a-zA-Z0-9_./-]+$/),
  sha256: hash,
});
const deployment = z.strictObject({
  resource: https.refine((s) => new URL(s).pathname === '/v1/mcp'),
  clientIds: z.array(label).min(1),
  rollback: z.strictObject({
    companionCommit: commit,
    runtimeCommit: commit,
    oracleVersion: label,
    gatewayVersion: label,
    configSha256: hash,
    authPolicyRevision: label,
  }),
});
export const candidateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  gateVersion: z.literal(1),
  gateSha256: hash,
  components: z.strictObject({
    qiforge: commit,
    companion: commit,
    authHub: commit,
    subscriptions: commit,
    memory: commit,
    vfs: commit,
    yellowcard: commit,
    knowledge: commit,
  }),
  runtime: z.strictObject({ version: label, sha256: hash }),
  catalog: z.strictObject({ version: z.literal('2.0.0'), sha256: hash }),
  model: z.strictObject({ id: label, promptSha256: hash }),
  modules: z.array(z.enum(TOOLS)),
  capsules: z.array(
    z.strictObject({
      id: z.enum(CAPSULES),
      authorCommit: commit,
      cid,
      archiveSha256: hash,
      rollbackCid: cid,
    }),
  ),
  networks: z.strictObject({
    devnet: deployment,
    testnet: deployment,
    mainnet: deployment,
  }),
});

const journeys = [
  'account',
  'credits',
  'topic',
  'error',
  'yesterday-file',
  'offramp',
  'personal-history',
  'oracle-procedure',
  'memory-shared',
  'memory-no-grant',
  'other-user-isolation',
];
export const REQUIRED_CASES = Object.freeze({
  baseline: [
    'authenticated-build',
    'worker-routing',
    'source-revisions',
    'authority-bindings',
  ],
  services: [
    'account-owner-network',
    'credits-zero',
    'credits-outage',
    'files-partial',
    'files-unindexed',
    'memory-revocation',
    'receipt-owner',
    'quote-expired',
    'quote-no-write',
  ],
  agent: ['user-a', 'user-b'].flatMap((user) =>
    ['oracle-a', 'oracle-b'].flatMap((oracle) =>
      journeys.map((journey) => `${user}/${oracle}/${journey}`),
    ),
  ),
  skills: CAPSULES.map((id) => `${id}/published-mounted-executed`),
  oauth: [
    'exact-resource-client',
    'expired-revoked',
    'wrong-audience',
    'cross-client',
    'downstream-narrowing',
    'migration-reauthorization',
    'current-membership',
  ],
  clients: ['native', 'chatgpt', 'claude'].flatMap((client) =>
    [
      'account',
      'files',
      'memory',
      'quote',
      'denial',
      'reconnect',
      'cancellation',
    ].map((id) => `${client}/${id}`),
  ),
  rollback: [
    'oracle-and-gateway',
    'disable-modules-ingress',
    'capsule-rollback',
    'auth-policy-forward-recovery',
    'no-financial-write',
  ],
  canary: [
    'successful-read',
    'refused-read',
    'source-outage',
    'partial-result',
    'no-critical-failure',
  ],
});
const receiptSchema = z.strictObject({
  gate: z.enum(Object.keys(REQUIRED_CASES)),
  network,
  candidateSha256: hash,
  kind: z.enum(['hosted', 'fixture']),
  observedAt: timestamp,
  subject: z.strictObject({
    oracleVersion: label,
    gatewayVersion: label,
    configSha256: hash,
    modelId: label,
    promptSha256: hash,
    runtimeSha256: hash,
    catalogSha256: hash,
    resource: https,
    clientIds: z.array(label).min(1),
    modules: z.array(z.enum(TOOLS)),
  }),
  cases: z.array(
    z.strictObject({
      id: label,
      result: z.enum(['PASS', 'FAIL', 'NOT_RUN', 'INCOMPLETE']),
      artifacts: z.array(file).min(1),
    }),
  ),
  review: z.strictObject({
    collector: label,
    reviewer: label,
    reviewedAt: timestamp,
    decision: z.enum(['ACCEPT', 'REJECT', 'PENDING']),
    attestation: file,
  }),
});
export const evidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  localConformance: file.nullable(),
  receipts: z.array(receiptSchema),
});
const sorted = (items) => [...items].sort();
const equal = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const fresh = (value, now) => {
  const age = now - Date.parse(value);
  return age >= 0 && age <= 24 * 60 * 60 * 1000;
};

const localReportSchema = z.object({
  generatedAt: timestamp,
  git: z.strictObject({ head: commit, dirty: z.boolean() }),
  sourceDigests: z.record(z.string(), hash),
  local: z.object({
    status: z.enum(['PASS', 'FAIL']),
    tests: z.array(
      z.object({ file: label, name: z.string().min(1), status: label }),
    ),
    rows: z.array(
      z.object({
        client: label,
        tool: label,
        status: label,
        negotiatedProtocol: z.string().nullable(),
        sourceCallCount: z.number().int().nonnegative(),
        expectedDomainDigest: hash,
        observedDomainDigest: hash,
        expectedEvidenceDigest: hash,
        observedEvidenceDigest: hash,
      }),
    ),
  }),
});

export function receiptDigest(receipt) {
  receipt = receiptSchema.parse(receipt);
  const review = { ...receipt.review };
  delete review.attestation;
  return digest(JSON.stringify({ ...receipt, review }));
}

export function assessRelease({
  candidate,
  evidence,
  artifacts,
  source,
  gateSha256,
  network: target,
  now,
}) {
  candidate = candidateSchema.parse(candidate);
  evidence = evidenceSchema.parse(evidence);
  network.parse(target);
  if (!Number.isFinite(now)) throw new Error('Invalid evaluation time');
  const candidateSha256 = digest(JSON.stringify(candidate));
  const blockers = [];
  const require = (condition, code) => {
    if (!condition) blockers.push(code);
  };
  require(candidate.gateSha256 === gateSha256, 'gate_digest_mismatch');
  require(equal(candidate.modules, TOOLS), 'module_set_mismatch');
  require(equal(
    candidate.capsules.map((c) => c.id),
    CAPSULES,
  ), 'capsule_set_mismatch');
  for (const n of NETWORKS) {
    const clients = candidate.networks[n].clientIds;
    require(new Set(clients).size === clients.length, `duplicate_client:${n}`);
  }
  require(new Set(NETWORKS.map((n) => candidate.networks[n].resource)).size ===
    3, 'network_resource_reused');
  function artifact(ref) {
    const bytes = artifacts.get(ref.path);
    const ok = bytes !== undefined && digest(bytes) === ref.sha256;
    require(ok, `artifact_missing_or_changed:${digest(ref.path)}`);
    return ok ? bytes : null;
  }
  const localBytes =
    evidence.localConformance && artifact(evidence.localConformance);
  if (!localBytes) require(false, 'local_conformance_missing');
  else {
    const report = localReportSchema.parse(
      JSON.parse(localBytes.toString('utf8')),
    );
    require(report.git?.head === candidate.components.qiforge &&
      report.git?.dirty === false, 'local_source_mismatch');
    require(fresh(report.generatedAt, now), 'local_conformance_stale');
    require(source?.head === candidate.components.qiforge &&
      source?.dirty === false, 'checkout_mismatch');
    const hashes = Object.entries(report.sourceDigests ?? {});
    require(equal(
      hashes.map(([path]) => path),
      SOURCE_PATHS,
    ) &&
      hashes.every(
        ([path, sha]) => source?.digests[path] === sha,
      ), 'local_source_digest_mismatch');
    const rerun = evaluateConformance({
      vitest: {
        testResults: [
          ...new Set(report.local?.tests?.map((t) => t.file) ?? []),
        ].map((name) => ({
          name,
          assertionResults: report.local.tests
            .filter((t) => t.file === name)
            .map((t) => ({
              fullName: t.name,
              status: t.status === 'PASS' ? 'passed' : 'failed',
            })),
        })),
      },
      observations: report.local?.rows?.map((row) => ({
        ...row,
        comparison: row.status === 'PASS' ? 'equal' : 'different',
        protocol: row.negotiatedProtocol,
      })),
      supportedProtocols: ['2025-11-25'],
      catalogNames: TOOLS,
    });
    require(report.local?.status === 'PASS' &&
      rerun.status === 'PASS', 'local_conformance_incomplete');
  }
  const through = NETWORKS.slice(0, NETWORKS.indexOf(target) + 1);
  const observed = new Map();
  const versions = new Map();
  for (const receipt of evidence.receipts) {
    const key = `${receipt.network}/${receipt.gate}`;
    require(!observed.has(key), `duplicate_gate:${key}`);
    observed.set(key, receipt);
    require(receipt.kind === 'hosted', `fixture_not_hosted:${key}`);
    require(receipt.candidateSha256 ===
      candidateSha256, `candidate_mismatch:${key}`);
    require(fresh(receipt.observedAt, now) &&
      fresh(receipt.review.reviewedAt, now) &&
      Date.parse(receipt.review.reviewedAt) >=
        Date.parse(receipt.observedAt), `stale_or_unordered_review:${key}`);
    require(receipt.review.decision === 'ACCEPT' &&
      receipt.review.reviewer !==
        receipt.review.collector, `review_missing:${key}`);
    const attestationBytes = artifact(receipt.review.attestation);
    if (attestationBytes) {
      const parsed = z
        .strictObject({
          schemaVersion: z.literal(1),
          receiptSha256: hash,
          reviewer: label,
          decision: z.literal('ACCEPT'),
        })
        .safeParse(
          (() => {
            try {
              return JSON.parse(attestationBytes.toString('utf8'));
            } catch {
              return null;
            }
          })(),
        );
      require(parsed.success &&
        parsed.data.receiptSha256 === receiptDigest(receipt) &&
        parsed.data.reviewer ===
          receipt.review.reviewer, `attestation_mismatch:${key}`);
    }
    const subject = receipt.subject;
    const config = candidate.networks[receipt.network];
    require(subject.runtimeSha256 === candidate.runtime.sha256 &&
      subject.catalogSha256 === candidate.catalog.sha256 &&
      subject.modelId === candidate.model.id &&
      subject.promptSha256 === candidate.model.promptSha256 &&
      subject.resource === config.resource &&
      equal(subject.clientIds, config.clientIds) &&
      equal(subject.modules, candidate.modules), `subject_mismatch:${key}`);
    const identity = JSON.stringify([
      subject.oracleVersion,
      subject.gatewayVersion,
      subject.configSha256,
    ]);
    require(!versions.has(receipt.network) ||
      versions.get(receipt.network) ===
        identity, `deployed_version_mismatch:${key}`);
    versions.set(receipt.network, identity);
    require(equal(
      receipt.cases.map((c) => c.id),
      REQUIRED_CASES[receipt.gate],
    ), `case_set_mismatch:${key}`);
    for (const row of receipt.cases) {
      require(row.result === 'PASS', `case_not_accepted:${key}/${row.id}`);
      for (const ref of row.artifacts) artifact(ref);
    }
  }
  for (const n of through)
    for (const gate of Object.keys(REQUIRED_CASES)) {
      require(observed.has(`${n}/${gate}`), `gate_missing:${n}/${gate}`);
    }
  for (const n of through) {
    const baseline = observed.get(`${n}/baseline`);
    const canary = observed.get(`${n}/canary`);
    for (const receipt of evidence.receipts.filter((r) => r.network === n)) {
      if (baseline && receipt.gate !== 'baseline') {
        require(Date.parse(baseline.review.reviewedAt) <=
          Date.parse(
            receipt.observedAt,
          ), `baseline_order:${n}/${receipt.gate}`);
      }
      if (canary && receipt.gate !== 'canary') {
        require(Date.parse(receipt.review.reviewedAt) <=
          Date.parse(canary.observedAt), `canary_order:${n}/${receipt.gate}`);
      }
    }
  }
  for (let i = 1; i < through.length; i++) {
    const previous = observed.get(`${through[i - 1]}/canary`);
    const next = observed.get(`${through[i]}/baseline`);
    if (previous && next)
      require(Date.parse(previous.review.reviewedAt) <=
        Date.parse(next.observedAt), `network_order:${through[i]}`);
  }
  return {
    schemaVersion: 1,
    gateVersion: 1,
    evaluatedAt: new Date(now).toISOString(),
    candidateSha256,
    network: target,
    assessment: blockers.length ? 'INCOMPLETE' : 'RECORDS_COMPLETE_FOR_REVIEW',
    blockers: [...new Set(blockers)],
    deploymentAuthorized: false,
    release: 'NOT_ESTABLISHED',
    trust:
      'Unsigned operator records and independent review attestations; byte integrity is not live truth or approval.',
  };
}
