import type {
  ActionRequest,
  ArtifactRef,
  ConsequenceDecision,
  ExecutionRequest,
  ExecutionReceipt,
  ExecutionTargetDescriptor,
  WorkspaceBinding,
  WorkspaceRevision,
} from '@ixo/common/work';

export interface PreparedExecution {
  request: ExecutionRequest;
  target: ExecutionTargetDescriptor;
}
export interface ExecutionTargetProvider {
  materializeArtifacts(
    files: Array<{ reference: ArtifactRef; bytes: Uint8Array }>,
  ): Promise<void>;
  inspect(): Promise<ExecutionTargetDescriptor>;
  prepare(request: ExecutionRequest): Promise<PreparedExecution>;
  execute(execution: PreparedExecution): Promise<ExecutionReceipt>;
  cancel(execution: PreparedExecution): Promise<'requested' | 'confirmed'>;
  collect(execution: PreparedExecution): Promise<ExecutionReceipt | null>;
  teardown(execution: PreparedExecution): Promise<void>;
}
export interface ConsequenceGuard {
  evaluate(action: ActionRequest): Promise<ConsequenceDecision>;
}
export interface WorkspaceAdapter {
  open(binding: WorkspaceBinding): Promise<void>;
  materialize(target: ExecutionTargetProvider): Promise<ArtifactRef[]>;
  snapshot(): Promise<ArtifactRef[]>;
  commit(
    message: string,
    provenance: Omit<WorkspaceRevision['provenance'], 'message'>,
  ): Promise<WorkspaceRevision>;
  restore(revision: ArtifactRef): Promise<WorkspaceRevision>;
  listArtifacts(): Promise<ArtifactRef[]>;
  close(): Promise<void>;
}
