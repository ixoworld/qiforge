import {
  ExecutionRequestSchema,
  ExecutionReceiptSchema,
  ExecutionTargetDescriptorSchema,
  SkillManifestSchema,
  type ArtifactRef,
  type ExecutionReceipt,
  type ExecutionRequest,
  type ExecutionTargetDescriptor,
  type SkillManifest,
} from '@ixo/common/work';
import { z } from 'zod';
import type { RuntimeContext } from '../plugin-api/types';
import {
  SandboxPlugin,
  type SandboxMcpClientFactory,
} from '../plugins/sandbox/sandbox.plugin';
import { parseOracleSecrets } from '../plugins/sandbox/sandbox-mcp';
import { readSandboxResult } from '../plugins/sandbox/sandbox-bridge';
import {
  canonicalArguments,
  isUncertainOutcome,
} from '../core/middlewares/tool-execution';
import type { ExecutionTargetProvider, PreparedExecution } from './contracts';

export interface SandboxExecutionTargetOptions {
  context: RuntimeContext;
  mcpClientFactory?: SandboxMcpClientFactory;
  manifest: SkillManifest;
  capsuleCid: string;
  skillPath: string;
  allowedCredentials: { user: readonly string[]; oracle: readonly string[] };
  authorizeExecution: () => Promise<void>;
}
const successEnvelope = z
  .object({
    success: z.literal(true),
    exitCode: z.literal(0),
    output: z.string().max(128000),
  })
  .passthrough();
const textBlocks = z.array(
  z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
);
function confirmedOutput(result: unknown): string {
  const blocks = textBlocks.safeParse(result);
  const value =
    blocks.success && blocks.data.length === 1 ? blocks.data[0]?.text : result;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(
        'Sandbox execution outcome unknown: missing result envelope',
      );
    }
  }
  const envelope = successEnvelope.safeParse(parsed);
  if (!envelope.success)
    throw new Error(
      'Sandbox execution outcome unknown: no confirmed successful receipt',
    );
  return envelope.data.output;
}
const inputId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export class SandboxExecutionTarget implements ExecutionTargetProvider {
  private readonly manifest: SkillManifest;
  private staged: Array<{ reference: ArtifactRef; bytes: Uint8Array }> = [];
  private lifecycle:
    | { kind: 'idle' }
    | { kind: 'executing'; binding: string; result: Promise<ExecutionReceipt> }
    | { kind: 'finished'; binding: string; receipt: ExecutionReceipt } = {
    kind: 'idle',
  };
  private readonly credentialValues = new Set<string>();
  private readonly disposables = new Set<() => void | Promise<void>>();
  private readonly plugin: SandboxPlugin;
  private readonly context: RuntimeContext;
  constructor(private readonly options: SandboxExecutionTargetOptions) {
    this.manifest = SkillManifestSchema.parse(options.manifest);
    if (!/^\/workspace\/skills\/[A-Za-z0-9_-]+$/.test(options.skillPath))
      throw new Error('Invalid pinned skill path');
    if (
      this.manifest.skillId !== options.capsuleCid ||
      !this.manifest.execution.targetKinds.includes('sandbox')
    )
      throw new Error('Skill does not match the sandbox target');
    this.context = {
      ...options.context,
      secrets: {
        ...options.context.secrets,
        getValues: async (names) => {
          const values = await options.context.secrets.getValues(names);
          for (const value of Object.values(values))
            if (value) this.credentialValues.add(value);
          return values;
        },
      },
      onTurnEnd: (dispose) => {
        this.disposables.add(dispose);
        options.context.onTurnEnd?.(dispose);
      },
    };
    this.plugin = new SandboxPlugin({
      mcpClientFactory: options.mcpClientFactory,
      selectCredentials: async () => {
        const user = this.manifest.execution.requiredCredentialNames.filter(
          (name) => options.allowedCredentials.user.includes(name),
        );
        const oracle = this.manifest.execution.requiredCredentialNames.filter(
          (name) => options.allowedCredentials.oracle.includes(name),
        );
        const configured = parseOracleSecrets(
          typeof this.context.config.ORACLE_SECRETS === 'string'
            ? this.context.config.ORACLE_SECRETS
            : '',
        );
        for (const name of oracle)
          if (configured[name]) this.credentialValues.add(configured[name]);
        return { user, oracle };
      },
    });
  }
  async materializeArtifacts(
    files: Array<{ reference: ArtifactRef; bytes: Uint8Array }>,
  ): Promise<void> {
    if (this.lifecycle.kind !== 'idle')
      throw new Error('Target execution has already started');
    if (
      files.some((file) => !/^[A-Za-z0-9_.-]+$/.test(file.reference.name)) ||
      files.reduce((total, file) => total + file.bytes.byteLength, 0) >
        10 * 1024 * 1024
    )
      throw new Error('Invalid selected target inputs');
    this.staged = files.map((file) => ({
      reference: { ...file.reference },
      bytes: file.bytes.slice(),
    }));
  }
  async inspect(): Promise<ExecutionTargetDescriptor> {
    return {
      version: 1,
      providerId: 'ixo-sandbox',
      targetId: `sandbox:${this.context.user.did}`,
      kind: 'sandbox',
      capabilities: ['pinned-skill', 'selected-inputs'],
      isolation: 'principal',
      locality: 'remote',
      lifecycle: 'persistent',
    };
  }
  async prepare(request: ExecutionRequest): Promise<PreparedExecution> {
    const parsed = ExecutionRequestSchema.parse(request);
    inputId.parse(parsed.requestId);
    if (parsed.principalDID !== this.context.user.did)
      throw new Error('Execution principal mismatch');
    if (parsed.timeoutMs > this.manifest.execution.timeoutMs)
      throw new Error('Execution exceeds the skill timeout');
    return { request: parsed, target: await this.inspect() };
  }
  async execute(execution: PreparedExecution): Promise<ExecutionReceipt> {
    const pinned = {
      request: ExecutionRequestSchema.parse(execution.request),
      target: ExecutionTargetDescriptorSchema.parse(execution.target),
    };
    await this.prepare(pinned.request);
    if (
      canonicalArguments(pinned.target) !==
      canonicalArguments(await this.inspect())
    )
      throw new Error('Target binding mismatch');
    const binding = canonicalArguments(pinned);
    if (this.lifecycle.kind !== 'idle') {
      if (this.lifecycle.binding !== binding)
        throw new Error('Target already executes different work');
      return ExecutionReceiptSchema.parse(
        this.lifecycle.kind === 'executing'
          ? await this.lifecycle.result
          : this.lifecycle.receipt,
      );
    }
    const result = this.run(pinned).then((receipt) => {
      this.lifecycle = { kind: 'finished', binding, receipt };
      return receipt;
    });
    this.lifecycle = { kind: 'executing', binding, result };
    return ExecutionReceiptSchema.parse(await result);
  }
  private async run(execution: PreparedExecution): Promise<ExecutionReceipt> {
    const startedAt = new Date().toISOString();
    const request = execution.request;
    let status: ExecutionReceipt['status'] = 'completed';
    let result: string | undefined;
    let failure: string | undefined;
    try {
      this.context.abortSignal.throwIfAborted();
      await this.prepare(request);
      if (
        canonicalArguments(execution.target) !==
        canonicalArguments(await this.inspect())
      )
        throw new Error('Target binding mismatch');
      const tools = await this.plugin.getRequestTools(this.context);
      const load = tools.find((tool) => tool.name === 'load_skill');
      const write = tools.find((tool) => tool.name === 'sandbox_write_file');
      const run = tools.find((tool) => tool.name === 'sandbox_run');
      if (!load || !write || !run)
        throw new Error('Sandbox does not expose pinned skill execution tools');
      if (
        canonicalArguments(request.artifacts) !==
        canonicalArguments(this.staged.map((file) => file.reference))
      )
        throw new Error('Selected artifacts were not completely materialized');
      this.context.abortSignal.throwIfAborted();
      const loaded = await load.handler(
        { cid: this.options.capsuleCid },
        this.context,
      );
      const loadBlocks = textBlocks.safeParse(loaded);
      const loadValue =
        loadBlocks.success && loadBlocks.data.length === 1
          ? loadBlocks.data[0]?.text
          : loaded;
      const loadEnvelope = z
        .object({ success: z.literal(true) })
        .passthrough()
        .safeParse(
          typeof loadValue === 'string' ? JSON.parse(loadValue) : loadValue,
        );
      if (!loadEnvelope.success)
        throw new Error('Pinned skill preparation failed');
      for (const file of this.staged) {
        const ref = file.reference;
        if (
          !request.artifacts.some(
            (artifact) =>
              canonicalArguments(artifact) === canonicalArguments(ref),
          )
        )
          throw new Error('Staged file does not match execution inputs');
        const hash = await crypto.subtle.digest('SHA-256', file.bytes);
        const digest = Array.from(new Uint8Array(hash), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        if (digest !== ref.sha256)
          throw new Error(
            'Staged bytes do not match the pinned artifact digest',
          );
        let binary = '';
        for (const byte of file.bytes) binary += String.fromCharCode(byte);
        this.context.abortSignal.throwIfAborted();
        const output = readSandboxResult(
          await write.handler(
            {
              path: `/workspace/data/qiforge-${request.requestId}-${ref.name}`,
              content: btoa(binary),
              encoding: 'base64',
            },
            this.context,
          ),
        );
        if (!output.ok)
          throw new Error(
            'Sandbox did not materialize the exact artifact version',
          );
      }
      const inputPath = `/workspace/data/qiforge-${request.requestId}-input.json`;
      this.context.abortSignal.throwIfAborted();
      const written = readSandboxResult(
        await write.handler(
          {
            path: inputPath,
            content: canonicalArguments(request.inputs),
            encoding: 'utf8',
          },
          this.context,
        ),
      );
      if (!written.ok)
        throw new Error('Sandbox did not materialize the selected inputs');
      const entrypoint = this.manifest.execution.entrypoint;
      const command = entrypoint.endsWith('.py')
        ? `python3 '${entrypoint}'`
        : entrypoint.endsWith('.js')
          ? `node '${entrypoint}'`
          : entrypoint.endsWith('.sh')
            ? `sh '${entrypoint}'`
            : `'./${entrypoint}'`;
      const code = `cd '${this.options.skillPath}' && test "$(sha256sum '${entrypoint}' | cut -d' ' -f1)" = '${this.manifest.digest}' && timeout ${Math.max(1, Math.floor(request.timeoutMs / 1000))}s ${command} '${inputPath}'`;
      await this.options.authorizeExecution();
      this.context.abortSignal.throwIfAborted();
      const executionResult = await run.handler(
        { cid: this.options.capsuleCid, code },
        this.context,
      );
      result = this.scrub(confirmedOutput(executionResult));
    } catch (error) {
      status =
        (error instanceof Error &&
          error.message.startsWith('Sandbox execution outcome unknown:')) ||
        isUncertainOutcome(error, this.context.abortSignal)
          ? 'unknown'
          : 'failed';
      failure = this.scrub(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await this.teardown(execution);
    }
    const receipt = ExecutionReceiptSchema.parse({
      version: 1,
      providerId: execution.target.providerId,
      targetId: execution.target.targetId,
      requestId: request.requestId,
      principalDID: request.principalDID,
      workRef: request.workRef,
      inputDigest: request.inputDigest,
      startedAt,
      completedAt: new Date().toISOString(),
      status,
      artifacts: [],
      evidenceRefs: [this.options.capsuleCid],
      result,
      failure,
    });
    return receipt;
  }
  private scrub(text: string): string {
    let scrubbed = text;
    for (const value of [...this.credentialValues].sort(
      (a, b) => b.length - a.length,
    ))
      scrubbed = scrubbed.split(value).join('[REDACTED]');
    return scrubbed;
  }
  async cancel(execution: PreparedExecution): Promise<'requested'> {
    await this.teardown(execution);
    return 'requested';
  }
  async collect(
    execution: PreparedExecution,
  ): Promise<ExecutionReceipt | null> {
    const binding = canonicalArguments({
      request: ExecutionRequestSchema.parse(execution.request),
      target: ExecutionTargetDescriptorSchema.parse(execution.target),
    });
    return this.lifecycle.kind === 'finished' &&
      this.lifecycle.binding === binding
      ? ExecutionReceiptSchema.parse(this.lifecycle.receipt)
      : null;
  }
  async teardown(_execution: PreparedExecution): Promise<void> {
    for (const dispose of this.disposables) await dispose();
    this.disposables.clear();
    this.staged = [];
  }
}
