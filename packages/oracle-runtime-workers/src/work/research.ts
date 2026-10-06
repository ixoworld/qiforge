import { z } from 'zod';
import { type ArtifactRef, type SkillManifest } from '@ixo/common/work';
import type { RuntimeContext, PluginTool } from '../plugin-api/types';
import type { DoSqliteDatabase } from '../sqlite/database';
import {
  createDefaultSkillsUcanBuilder,
  loadRegistrySkillManifest,
} from '../core/plugins/skills/skills-tools';
import { VfsClient } from '../plugins/vfs/vfs-client';
import { vfsBearer } from '../plugins/vfs/vfs-auth';
import {
  VFS_DEFAULT_BASE_URLS,
  UCAN_STORE_DEFAULT_URLS,
} from '../owner-store/ixo-vfs-store';
import { canonicalArguments } from '../core/middlewares/tool-execution';
import {
  researchInputDigest,
  type TopicResearchRequest,
} from '../tasks/topic-research';
import { SandboxExecutionTarget } from './sandbox-target';
import { ExecutionReceiptStore } from './execution-store';
import { VfsWorkspaceAdapter } from './vfs-workspace';
import { createConsequenceGuard } from './consequence-guard';

export interface ResearchSkillActivation {
  id: string;
  version: string;
  digest: string;
  publisherDid: string;
}
export interface TopicResearchAuthority {
  observedRevision: string;
  resourceRef: string;
  allowed: boolean;
}
export interface TopicResearchHost {
  allowedSkills: readonly ResearchSkillActivation[];
  allowedCredentials: { user: readonly string[]; oracle: readonly string[] };
  /** Reread canonical Topic state, membership and current action authority. */
  resolveTopicAuthority: (input: {
    principalDid: string;
    topic: TopicResearchRequest['topic'];
    request: TopicResearchRequest;
  }) => Promise<TopicResearchAuthority>;
}
export interface ResearchExecutionOptions {
  db: DoSqliteDatabase;
  operationId: string;
  request: TopicResearchRequest;
  host: TopicResearchHost;
  authorizeCurrent: (context: RuntimeContext) => Promise<void>;
}
function configString(ctx: RuntimeContext, name: string): string {
  const value = ctx.config[name];
  if (typeof value !== 'string' || !value)
    throw new Error(`${name} is required for Topic research`);
  return value;
}
function workspace(
  ctx: RuntimeContext,
  resource: string,
  startedAt: string,
  workspaceId: string,
  authorizeMutation: () => Promise<void>,
): VfsWorkspaceAdapter {
  const network =
    ctx.config.NETWORK === 'devnet'
      ? 'devnet'
      : ctx.config.NETWORK === 'testnet'
        ? 'testnet'
        : 'mainnet';
  const cfg = {
    VFS_BASE_URL:
      typeof ctx.config.VFS_BASE_URL === 'string'
        ? ctx.config.VFS_BASE_URL
        : (VFS_DEFAULT_BASE_URLS[network] ?? 'https://vfs.ixo.earth'),
    UCAN_STORE_URL:
      typeof ctx.config.UCAN_STORE_URL === 'string'
        ? ctx.config.UCAN_STORE_URL
        : (UCAN_STORE_DEFAULT_URLS[network] ?? 'https://store.ucan.ixo.earth'),
    VFS_MAX_READ_LINES: 2000,
    VFS_REQUEST_TIMEOUT_MS: 20000,
  };
  return new VfsWorkspaceAdapter(
    new VfsClient({
      baseUrl: cfg.VFS_BASE_URL.replace(/\/$/, '') + '/api/fs',
      mint: (ability) =>
        vfsBearer(ctx, cfg, ability, resource, [`/.workspaces/${workspaceId}`]),
      timeoutMs: 20000,
      signal: ctx.abortSignal,
    }),
    () => startedAt,
    authorizeMutation,
  );
}
export async function assertResearchAuthority(
  options: Pick<
    ResearchExecutionOptions,
    'request' | 'host' | 'authorizeCurrent'
  >,
  ctx: RuntimeContext,
  resourceRef?: string,
) {
  await options.authorizeCurrent(ctx);
  const current = await options.host.resolveTopicAuthority({
    principalDid: ctx.user.did,
    topic: options.request.topic,
    request: options.request,
  });
  if (
    !current.allowed ||
    (resourceRef !== undefined && current.resourceRef !== resourceRef) ||
    current.observedRevision !== options.request.topic.observedRevision ||
    !/^ixo:filesystem(?:\/did:ixo:entity:[A-Za-z0-9._:-]+)?$/.test(
      current.resourceRef,
    )
  )
    throw new Error(
      'Current Topic authority or revision does not match the frozen request',
    );
  await options.authorizeCurrent(ctx);
  for (const capability of options.request.capabilities)
    ctx.ucan.requireCapability(capability.with, capability.can);
  return current;
}
function activate(
  options: ResearchExecutionOptions,
  manifest: SkillManifest,
): void {
  const requested = options.request.skill;
  if (
    !options.host.allowedSkills.some(
      (skill) =>
        skill.id === requested.id &&
        skill.version === requested.version &&
        skill.digest === requested.digest.replace(/^sha256:/, '') &&
        skill.publisherDid === manifest.provenance.publisherDid,
    ) ||
    manifest.skillVersion !== requested.version ||
    manifest.digest !== requested.digest.replace(/^sha256:/, '') ||
    manifest.consequence !== 'none' ||
    !manifest.privilegePlanes.every((plane) => plane === 'orchestration') ||
    !manifest.acceptedWorkTypes.includes('topic-research')
  )
    throw new Error(
      'This pinned skill is not activated for bounded Topic research',
    );
  for (const required of manifest.requiredCapabilities)
    if (
      !options.request.capabilities.some(
        (cap) => cap.with === required.with && cap.can === required.can,
      )
    )
      throw new Error('Frozen request omits a required skill capability');
  for (const required of manifest.execution.requiredCredentialNames)
    if (
      !options.request.credentialNames.includes(required) ||
      ![
        ...options.host.allowedCredentials.user,
        ...options.host.allowedCredentials.oracle,
      ].includes(required)
    )
      throw new Error(
        'Current host policy does not allow a required skill credential',
      );
}
export function buildTopicResearchTool(
  options: ResearchExecutionOptions,
): PluginTool {
  return {
    name: 'run_topic_research',
    description:
      'Run the single host-approved trusted read-only research skill with frozen Topic inputs and commit its evidence to versioned VFS. The model cannot submit code or gain publication, determination or settlement authority. The persistent principal sandbox relies on the reviewed skill to avoid ambient-file reads and network writes.',
    schema: z.object({}).strict(),
    effect: 'write',
    annotations: { idempotentHint: true },
    handler: async (_args, ctx) => {
      const current = await assertResearchAuthority(options, ctx);
      const inputDigest = await researchInputDigest(options.request);
      const guard = createConsequenceGuard({
        policyVersion: 'topic-research-v1',
        allowedConsequences: ['none'],
        authorize: async () => {
          await assertResearchAuthority(options, ctx, current.resourceRef);
          return true;
        },
      });
      const decision = await guard.evaluate({
        version: 1,
        actionId: options.operationId,
        principalDID: ctx.user.did,
        resourceRef: current.resourceRef,
        inputDigest,
        privilegePlane: 'orchestration',
        consequence: 'none',
        requiredCapabilities: options.request.capabilities,
        evidenceRefs: [],
        decisionRefs: [],
      });
      if (decision.decision !== 'allow') throw new Error(decision.reason);
      const pinned = await loadRegistrySkillManifest(
        ctx,
        {
          baseUrl: configString(ctx, 'SKILLS_CAPSULES_BASE_URL'),
          network:
            typeof ctx.config.NETWORK === 'string'
              ? ctx.config.NETWORK
              : 'mainnet',
          ucanBuilder: createDefaultSkillsUcanBuilder(),
        },
        options.request.skill.id,
      );
      activate(options, pinned.manifest);
      const target = new SandboxExecutionTarget({
        context: ctx,
        manifest: pinned.manifest,
        capsuleCid: pinned.cid,
        skillPath: pinned.path,
        allowedCredentials: options.host.allowedCredentials,
        authorizeExecution: async () => {
          await assertResearchAuthority(options, ctx, current.resourceRef);
          activate(options, pinned.manifest);
        },
      });
      const prepared = await target.prepare({
        version: 1,
        requestId: options.operationId,
        principalDID: ctx.user.did,
        workRef: `topic:${options.request.topic.id}/${options.request.topic.attemptId}`,
        operation: 'research',
        inputDigest,
        inputs: {
          workspaceResource: current.resourceRef,
          request: canonicalArguments({
            goal: options.request.goal,
            instructions: options.request.instructions,
            sources: options.request.sources,
          }),
        },
        artifacts: [],
        timeoutMs: pinned.manifest.execution.timeoutMs,
        requestedCapabilities: options.request.capabilities,
      });
      await assertResearchAuthority(options, ctx, current.resourceRef);
      activate(options, pinned.manifest);
      const store = new ExecutionReceiptStore(options.db);
      const execution = await store.begin(options.operationId, prepared);
      if (execution.state === 'unknown')
        throw new Error(
          'Prior sandbox execution is unknown; an owner must inspect its outcome before creating a new operation',
        );
      let receipt = execution.receipt;
      if (!receipt) {
        receipt = await target.execute(prepared);
        await store.record(options.operationId, receipt);
      }
      if (receipt.status !== 'completed' || !receipt.result?.trim())
        throw new Error(`Research target outcome: ${receipt.status}`);
      await assertResearchAuthority(options, ctx, current.resourceRef);
      const files = workspace(
        ctx,
        current.resourceRef,
        execution.startedAt,
        options.operationId,
        async () => {
          await assertResearchAuthority(options, ctx, current.resourceRef);
        },
      );
      await files.open({
        version: 1,
        workspaceId: options.operationId,
        principalDID: ctx.user.did,
        resourceRef: current.resourceRef,
        rootPath: `/.workspaces/${options.operationId}/`,
      });
      const evidence = await files.put(
        'research-evidence.md',
        receipt.result,
        'text/markdown',
      );
      const revision = await files.commit(
        'Committed authorized research evidence',
        { principalDID: ctx.user.did, workRef: receipt.workRef, inputDigest },
      );
      await assertResearchAuthority(options, ctx, current.resourceRef);
      const manifest = files.getRevisionArtifact();
      return {
        evidence: receipt.result,
        artifacts: [evidence, ...(manifest ? [manifest] : [])],
        revision: revision.revision,
        inputDigest,
      };
    },
  };
}
export async function commitResearchReport(
  options: ResearchExecutionOptions,
  ctx: RuntimeContext,
  markdown: string,
): Promise<ArtifactRef[]> {
  const current = await assertResearchAuthority(options, ctx);
  const inputDigest = await researchInputDigest(options.request);
  const execution = await new ExecutionReceiptStore(options.db).read(
    options.operationId,
    inputDigest,
    ctx.user.did,
    `topic:${options.request.topic.id}/${options.request.topic.attemptId}`,
  );
  if (execution?.state !== 'completed' || !execution.receipt)
    throw new Error('A report requires committed successful research evidence');
  if (
    execution.binding.request.inputs.workspaceResource !== current.resourceRef
  )
    throw new Error('Workspace resource binding changed');
  const files = workspace(
    ctx,
    current.resourceRef,
    execution.startedAt,
    options.operationId,
    async () => {
      await assertResearchAuthority(options, ctx, current.resourceRef);
    },
  );
  await files.open({
    version: 1,
    workspaceId: options.operationId,
    principalDID: ctx.user.did,
    resourceRef: current.resourceRef,
    rootPath: `/.workspaces/${options.operationId}/`,
  });
  const evidence = await files.put(
    'research-evidence.md',
    execution.receipt.result ?? '',
    'text/markdown',
  );
  const report = await files.put('report.md', markdown, 'text/markdown');
  await files.commit('Committed report for human Topic review', {
    principalDID: ctx.user.did,
    workRef: execution.receipt.workRef,
    inputDigest,
  });
  await assertResearchAuthority(options, ctx, current.resourceRef);
  const revision = files.getRevisionArtifact();
  return [evidence, report, ...(revision ? [revision] : [])];
}
