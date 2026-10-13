// Adapted from ixoworld/domain.md examples/oracle-capsule (Apache-2.0).
export const capsuleFixture = {
  apiVersion: 'ixo.earth/oracle-capsule/v0alpha1',
  kind: 'OracleCapsuleRelease',
  schema: 'urn:ixo:domain-md:x-oracle-capsule:manifest:0.1.0',
  metadata: {
    name: 'livelihoods-shadow-minimal',
    release: '0.1.0',
    created: '2026-07-19T00:00:00Z',
    issuer: 'did:ixo:oracle-capsule-builder',
    operator: 'did:ixo:oracle-capsule-operator',
    release_digest:
      'b8a1b3c669d9b9a819b8c3f23e1f8a70d76eded5fe59b0aed88b03ff5cae398a',
    supersedes: null,
  },
  provenance: {
    repository: 'https://github.com/ixoworld/domain.md',
    commit: '4a6c1615433e073d7f40b56eb96e382cdf00fb9c',
    builder: 'did:ixo:oracle-capsule-builder',
    build_attestation: null,
    reviewed_contract: {
      repository: 'https://github.com/ixoworld/domain.md',
      commit: '4a6c1615433e073d7f40b56eb96e382cdf00fb9c',
      architecture_sha256:
        '2f396097d0bde3363cbad6aa43f16a718da08c0550b77df1ffcb2c91255d7bc8',
      threat_model_sha256:
        '17a08eebc8ebec931a9e402e7fcbde56241718bc3d61df9a0dfbbc602d8548f4',
    },
  },
  compatibility: {
    contract_major: 'v0alpha1',
    minimum_kernel: '0.1.0',
    required_features: ['strict-json', 'rfc8785-jcs', 'source-lock'],
    hosts: ['codex', 'claude', 'pi', 'cli', 'mcp'],
  },
  domains: {
    oracle: {
      id: 'did:ixo:oracle:livelihoods-verification',
      uri: 'ipfs://bafkreifqfy2hr2675fssl7lt75pu76ucdjygbcvidhnd6srfiuw2p2vx6i',
      cid: 'bafkreifqfy2hr2675fssl7lt75pu76ucdjygbcvidhnd6srfiuw2p2vx6i',
      sha256:
        'b02e3478ebdfe96525fd73ff5f4ffa821a70608aa819da3f4a25452da7eab7f2',
      version: '1.0.0-rc.2',
    },
    subjects: [
      {
        id: 'did:ixo:project:livelihoods-pilot',
        uri: 'ipfs://bafkreiagna53etruuaixxaiyaya7gpf6d73rwzxrpxriedvwkt7cjg4nrq',
        cid: 'bafkreiagna53etruuaixxaiyaya7gpf6d73rwzxrpxriedvwkt7cjg4nrq',
        sha256:
          '06683bb24e34a0117b81180601f33cbe1ff71b66f17de2820eb654fe249b8d8c',
        version: '1.0.0-rc.2',
      },
    ],
  },
  components: [
    {
      id: 'master',
      kind: 'master_skill',
      required: true,
      artifact: {
        uri: 'ipfs://bafkreifqfy2hr2675fssl7lt75pu76ucdjygbcvidhnd6srfiuw2p2vx6i',
        cid: 'bafkreifqfy2hr2675fssl7lt75pu76ucdjygbcvidhnd6srfiuw2p2vx6i',
        sha256:
          'b02e3478ebdfe96525fd73ff5f4ffa821a70608aa819da3f4a25452da7eab7f2',
        media_type: 'application/vnd.ixo.skill+tar',
        bytes: 36,
        source_lock: {
          uri: 'ipfs://bafkreih2fzv75odfuk33kymlogyl3liib7bwjh4de7jmqilb5bxqqfjgsy',
          cid: 'bafkreih2fzv75odfuk33kymlogyl3liib7bwjh4de7jmqilb5bxqqfjgsy',
          sha256:
            'fa2e6bfeb865a2b7b5618b71b0bdad080fc3649f8327d2c82161e86f08152696',
          media_type: 'application/vnd.ixo.oracle-capsule.source-lock+json',
          bytes: 560,
        },
      },
      version: '0.1.0',
      owner: 'did:ixo:oracle-capsule-builder',
      update_authority: ['did:ixo:oracle-capsule-builder'],
      compatibility: ['v0alpha1'],
      dependencies: [],
      disclosure: 'public',
      loading_policy: 'bootstrap',
      runtime_writable: false,
      entrypoint: 'SKILL.md',
    },
  ],
  tools: [],
  requestedCapabilities: [],
  effectCeiling: {
    mode: 'propose_only',
    allowed: ['draft_evaluation', 'request_human_review'],
    forbidden: ['final_determination', 'move_value', 'mutate_canonical_state'],
    human_review_required_for: ['draft_evaluation'],
  },
  external_checks_required: [
    'oracle-identity-current',
    'subject-domain-current',
    'capability-current-and-unrevoked',
    'trusted-time-available',
    'private-resource-access-authorized',
    'human-review-authorized',
    'runtime-distribution-trusted',
    'receipt-signer-current-and-unrevoked',
  ],
};
