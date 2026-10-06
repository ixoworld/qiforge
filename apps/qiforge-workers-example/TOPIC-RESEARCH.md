# Activate trusted Topic research on Workers

The example remains inactive by default. Activate only after providing a live canonical Topic authority resolver and verifying the service grants and trusted skill described below. The existing supplied-evidence endpoint remains available independently.

Import the public host type and add this hook to the existing `createOracleWorker` options:

```ts
import type { TopicResearchHost } from '@ixo/oracle-runtime-workers/work';

const topicResearch: TopicResearchHost = {
  allowedSkills: [
    // Populate from the reviewed capsule's actual CID, version, SHA-256 entrypoint digest and publisher DID.
  ],
  allowedCredentials: { user: [], oracle: [] },
  resolveTopicAuthority: async ({ principalDid, topic, request }) => {
    // Use your existing canonical Topic repository/service and current Matrix/UCAN authority.
    // Reread topic.id in topic.roomId, confirm current membership and that principalDid may research
    // this attempt, then return its current opaque revision and filesystem namespace.
    // Never echo request.topic.observedRevision as a substitute for reading current state.
    throw new Error(
      'Wire the operator canonical Topic authority resolver before activation',
    );
  },
};

const oracle = createOracleWorker({
  config,
  plugins,
  hooks: { topicResearch },
});
```

The resolver returns `{ allowed, observedRevision, resourceRef }`. `resourceRef` is `ixo:filesystem` or `ixo:filesystem/did:ixo:entity:<entity>`. A deployment-specific adapter is required because the runtime is not the canonical Topic authority. In particular, read the revision after the Portal has created the canonical delivery attempt. The returned revision/resource must stay equal to the frozen operation binding through execution and file commit.

Set `TOPIC_RESEARCH_ENABLED=true` only after wiring that resolver. Configure the existing `UCAN_STORE_URL`, `SKILLS_CAPSULES_BASE_URL`, `SANDBOX_MCP_URL`, `VFS_BASE_URL`, runtime identity/model and Matrix gateway. No CopilotKit/Intelligence setting is used. Every research request uses the current SDK's authenticated request transport with a signed UCAN invocation; bare delegation auth cannot start/read/cancel research. The queued owner delegation is freshly signature/revocation checked again at execution and commit.

Publish a reviewed registry capsule with a JSON string sidecar at `metadata.qiforgeManifest`, validated by `SkillManifestSchema` from `@ixo/common/work`. Pin its CID, skill version, entrypoint SHA-256 and publisher DID in `allowedSkills`. Its accepted work type must include `topic-research`, consequence must be `none`, privilege planes only `orchestration`, and target kinds include `sandbox`. The entrypoint receives one JSON filename argument containing selected goal/instructions/sources and workspace-resource metadata. It returns research evidence on stdout. Do not rely on skill prose or sidecar metadata to grant authority.

The current sandbox shares a persistent per-principal filesystem and network context. Activate only trusted reviewed read-only skills that do not read unrelated prior files, publish external effects, determine outcomes or settle payments. The selected secret names are metadata requirements and must intersect current host user/oracle allowlists; default both lists to empty. Local result redaction removes selected raw secret values but does not cover transformed leaks or upstream raw logs. Execution-isolated providers are required for untrusted skills.

The wire request is exported as `TopicResearchRequestSchema`; use `researchInputDigest` for the exact canonical digest. Routes are `PUT/GET /topic-research/:operationId` and `POST /topic-research/:operationId/cancel` with the exact frozen original request. A response includes `operationId`, `taskId`, `requesterDid`, exact Topic scope/revision, `inputDigest`, status, an always-present `artifacts` array and optional output/delivery. Artifact versions are numeric; hashes are bare SHA-256. The owner API does not publish a shared result or approve it. The Portal shares an immutable Matrix receipt packet and applies reviewer-owned access plus canonical Topic publication checks.

Before release, run real workerd, UCAN, Matrix, skills registry, sandbox and VFS acceptance with two independently authorized identities. Check cancellation during preparation/commit, current revocation, unknown sandbox outcome, retained VFS versions and replacement, duplicate wakes/delivery retries, and private checkpoint/credential exclusion. Missing live configuration is an acceptance blocker, not a skipped test. See [runtime architecture and evidence limits](../../docs/architecture/workers-shared-workspaces.md).
