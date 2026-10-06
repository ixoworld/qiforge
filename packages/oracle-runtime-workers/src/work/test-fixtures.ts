import type {
  ArtifactRef,
  ExecutionRequest,
  SkillManifest,
} from '@ixo/common/work';
import { makeRuntimeContext } from '../core/test-fixtures';
import { createUnsignedUcanAdapter } from '../core/runtime-context';
export const manifest: SkillManifest = {
  version: 1,
  skillId: 'capsule1',
  skillVersion: '1',
  digest: 'a'.repeat(64),
  acceptedWorkTypes: ['topic-research'],
  requiredCapabilities: [],
  privilegePlanes: ['orchestration'],
  execution: {
    targetKinds: ['sandbox'],
    entrypoint: 'research.py',
    timeoutMs: 3000,
    requiredCredentialNames: ['MY_KEY'],
  },
  outputs: [],
  consequence: 'none',
  provenance: {
    publisherDid: 'did:ixo:publisher',
    sourceRef: 'registry:capsule1',
  },
};
export const executionRequest: ExecutionRequest = {
  version: 1,
  requestId: 'operation1',
  principalDID: 'did:ixo:user1',
  workRef: 'topic:one/attempt',
  operation: 'research',
  inputDigest: 'b'.repeat(64),
  inputs: { goal: 'Research' },
  artifacts: [],
  timeoutMs: 3000,
  requestedCapabilities: [],
};
export const artifact: ArtifactRef = {
  resource: 'ixo:filesystem',
  fileId: 'file1',
  version: 1,
  cid: 'cid1',
  sha256: 'c'.repeat(64),
  name: 'source.md',
  path: '/.workspaces/one/source.md',
  mediaType: 'text/markdown',
  bytes: 6,
};
export function context() {
  return makeRuntimeContext(
    {},
    {
      ambient: {
        config: {
          SANDBOX_MCP_URL: 'https://sandbox.example/mcp',
          SKILLS_CAPSULES_BASE_URL: 'https://skills.example',
          ORACLE_SECRETS: 'OTHER=private',
        },
        ucan: {
          ...createUnsignedUcanAdapter(),
          hasSigningKey: () => true,
          resolveServiceDid: async () => 'did:web:sandbox.example',
          mintInvocation: async () => 'sandbox-token',
        },
        secrets: {
          getIndex: async () => ({ MY_KEY: { key: 'MY_KEY' } }),
          getValues: async (_room, names): Promise<Record<string, string>> =>
            names.includes('MY_KEY') ? { MY_KEY: 'abc' } : {},
        },
      },
      runConfig: {
        context: {
          user: {
            did: 'did:ixo:user1',
            matrixUserId: '@user:example.org',
            ucanDelegation: { raw: 'delegation' },
          },
          session: {
            id: 'session1',
            client: 'matrix',
            requestId: 'req1',
            roomId: '!owner:example.org',
          },
        },
      },
    },
  );
}
