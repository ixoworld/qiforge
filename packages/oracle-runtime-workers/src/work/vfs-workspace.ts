import {
  ArtifactRefSchema,
  WorkspaceBindingSchema,
  WorkspaceRevisionSchema,
  type ArtifactRef,
  type WorkspaceBinding,
  type WorkspaceRevision,
} from '@ixo/common/work';
import { canonicalArguments } from '../core/middlewares/tool-execution';
import { markdownDigest } from '../tasks/topic-deliverables';
import { VfsHttpError } from '../plugins/vfs/vfs-errors';
import type { VfsClient } from '../plugins/vfs/vfs-client';
import type { ExecutionTargetProvider, WorkspaceAdapter } from './contracts';

export class VfsWorkspaceAdapter implements WorkspaceAdapter {
  private binding: WorkspaceBinding | undefined;
  private artifacts: ArtifactRef[] = [];
  private parentRevision: string | undefined;
  private lastRevision: WorkspaceRevision | undefined;
  private revisionArtifact: ArtifactRef | undefined;
  constructor(
    private readonly client: VfsClient,
    private readonly now = () => new Date().toISOString(),
    private readonly authorizeMutation: () => Promise<void> = async () =>
      undefined,
  ) {}
  async open(binding: WorkspaceBinding): Promise<void> {
    const parsed = WorkspaceBindingSchema.parse(binding);
    if (parsed.rootPath !== `/.workspaces/${parsed.workspaceId}/`)
      throw new Error('Workspace path must match its binding');
    this.binding = parsed;
    this.artifacts = [];
    this.parentRevision = undefined;
    this.lastRevision = undefined;
    this.revisionArtifact = undefined;
  }
  private current(): WorkspaceBinding {
    if (!this.binding) throw new Error('Workspace is not open');
    return this.binding;
  }
  async put(
    name: string,
    content: string,
    mediaType: string,
  ): Promise<ArtifactRef> {
    const binding = this.current();
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..')
      throw new Error('Invalid workspace filename');
    const sha256 = await markdownDigest(content);
    const path = `${binding.rootPath}objects/${sha256}/${name}`;
    let file;
    try {
      await this.authorizeMutation();
      file = await this.client.create(path, content, mediaType);
    } catch (error) {
      if (!(error instanceof VfsHttpError) || error.status !== 409) throw error;
      await this.authorizeMutation();
      file = await this.client.statWorkspacePath(path);
    }
    await this.authorizeMutation();
    if (!file?.id || !file.version || !file.cid || file.contentHash !== sha256)
      throw new Error(
        'VFS did not return the exact committed file version and digest',
      );
    const artifact = ArtifactRefSchema.parse({
      resource: binding.resourceRef,
      fileId: file.id,
      version: file.version,
      cid: file.cid,
      sha256,
      name,
      path,
      mediaType,
      bytes: new TextEncoder().encode(content).byteLength,
    });
    if (
      !this.artifacts.some(
        (existing) =>
          existing.fileId === artifact.fileId &&
          existing.version === artifact.version,
      )
    )
      this.artifacts.push(artifact);
    return ArtifactRefSchema.parse(artifact);
  }
  async materialize(target: ExecutionTargetProvider): Promise<ArtifactRef[]> {
    this.current();
    const references = await this.snapshot();
    const files: Array<{ reference: ArtifactRef; bytes: Uint8Array }> = [];
    let total = 0;
    for (const reference of references) {
      const file = await this.client.versionContentBytes(
        reference.fileId,
        reference.version,
        10 * 1024 * 1024,
      );
      total += file.bytes.byteLength;
      if (total > 10 * 1024 * 1024)
        throw new Error(
          'Selected workspace inputs exceed the sandbox transfer limit',
        );
      const hash = await crypto.subtle.digest('SHA-256', file.bytes);
      const actual = Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      if (actual !== reference.sha256)
        throw new Error('Workspace artifact digest mismatch');
      files.push({ reference, bytes: new Uint8Array(file.bytes) });
    }
    await target.materializeArtifacts(files);
    return references;
  }
  async snapshot(): Promise<ArtifactRef[]> {
    this.current();
    return this.artifacts.map((artifact) => ({ ...artifact }));
  }
  async commit(
    message: string,
    provenance: Omit<WorkspaceRevision['provenance'], 'message'>,
  ): Promise<WorkspaceRevision> {
    const binding = this.current();
    if (provenance.principalDID !== binding.principalDID)
      throw new Error('Workspace principal mismatch');
    const artifacts = await this.snapshot();
    if (
      this.lastRevision &&
      canonicalArguments({
        artifacts,
        provenance: { ...provenance, message },
      }) ===
        canonicalArguments({
          artifacts: this.lastRevision.artifacts,
          provenance: this.lastRevision.provenance,
        })
    )
      return WorkspaceRevisionSchema.parse(this.lastRevision);
    const content = {
      workspaceId: binding.workspaceId,
      parentRevision: this.parentRevision,
      artifacts,
      provenance: { ...provenance, message },
    };
    const revision = await markdownDigest(canonicalArguments(content));
    const record = WorkspaceRevisionSchema.parse({
      version: 1,
      ...content,
      revision,
      createdAt: this.now(),
    });
    this.revisionArtifact = await this.put(
      `revision-${revision}.json`,
      canonicalArguments(record),
      'application/json',
    );
    this.artifacts = artifacts;
    this.parentRevision = revision;
    this.lastRevision = record;
    return WorkspaceRevisionSchema.parse(record);
  }
  getRevisionArtifact(): ArtifactRef | undefined {
    return this.revisionArtifact ? { ...this.revisionArtifact } : undefined;
  }
  async restore(reference: ArtifactRef): Promise<WorkspaceRevision> {
    const binding = this.current();
    const artifact = ArtifactRefSchema.parse(reference);
    if (
      artifact.resource !== binding.resourceRef ||
      !artifact.path.startsWith(binding.rootPath)
    )
      throw new Error('Revision is outside this workspace');
    const result = await this.client.versionContentBytes(
      artifact.fileId,
      artifact.version,
      128000,
    );
    const text = new TextDecoder().decode(result.bytes);
    if ((await markdownDigest(text)) !== artifact.sha256)
      throw new Error('Workspace revision digest mismatch');
    const record = WorkspaceRevisionSchema.parse(JSON.parse(text));
    if (
      record.workspaceId !== binding.workspaceId ||
      record.provenance.principalDID !== binding.principalDID
    )
      throw new Error('Workspace revision binding mismatch');
    const expected = await markdownDigest(
      canonicalArguments({
        workspaceId: record.workspaceId,
        parentRevision: record.parentRevision,
        artifacts: record.artifacts,
        provenance: record.provenance,
      }),
    );
    if (
      expected !== record.revision ||
      record.artifacts.some(
        (file) =>
          file.resource !== binding.resourceRef ||
          !file.path.startsWith(binding.rootPath),
      )
    )
      throw new Error('Invalid workspace revision');
    this.artifacts = record.artifacts;
    this.parentRevision = record.revision;
    this.lastRevision = record;
    this.revisionArtifact = artifact;
    return WorkspaceRevisionSchema.parse(record);
  }
  listArtifacts(): Promise<ArtifactRef[]> {
    return this.snapshot();
  }
  async close(): Promise<void> {
    this.binding = undefined;
    this.artifacts = [];
    this.revisionArtifact = undefined;
  }
}
