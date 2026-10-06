import {
  ExecutionReceiptSchema,
  ExecutionRequestSchema,
  ExecutionTargetDescriptorSchema,
  type ExecutionReceipt,
} from '@ixo/common/work';
import type { DoSqliteDatabase } from '../sqlite/database';
import { canonicalArguments } from '../core/middlewares/tool-execution';
import type { PreparedExecution } from './contracts';

type ExecutionRow = {
  input_digest: string;
  binding_json: string;
  state: string;
  started_at: string;
  receipt_json: string | null;
};
export interface StoredExecution {
  state: 'started' | 'completed' | 'unknown';
  binding: PreparedExecution;
  startedAt: string;
  receipt?: ExecutionReceipt;
}
function binding(input: PreparedExecution): PreparedExecution {
  return {
    request: ExecutionRequestSchema.parse(input.request),
    target: ExecutionTargetDescriptorSchema.parse(input.target),
  };
}
function boundReceipt(row: ExecutionRow): ExecutionReceipt | undefined {
  if (!row.receipt_json) return undefined;
  const receipt = ExecutionReceiptSchema.parse(JSON.parse(row.receipt_json));
  const prepared = binding(JSON.parse(row.binding_json));
  if (
    receipt.inputDigest !== prepared.request.inputDigest ||
    receipt.requestId !== prepared.request.requestId ||
    receipt.principalDID !== prepared.request.principalDID ||
    receipt.workRef !== prepared.request.workRef ||
    receipt.providerId !== prepared.target.providerId ||
    receipt.targetId !== prepared.target.targetId
  )
    throw new Error('Receipt does not match the prepared target and execution');
  return receipt;
}
export class ExecutionReceiptStore {
  constructor(private readonly db: DoSqliteDatabase) {}
  async setup(): Promise<void> {
    await this.db.run(
      'CREATE TABLE IF NOT EXISTS workspace_executions (operation_id TEXT PRIMARY KEY,input_digest TEXT NOT NULL,binding_json TEXT NOT NULL,state TEXT NOT NULL,started_at TEXT NOT NULL,receipt_json TEXT)',
    );
  }
  private async row(operationId: string): Promise<ExecutionRow | undefined> {
    await this.setup();
    return this.db.get<ExecutionRow>(
      'SELECT input_digest,binding_json,state,started_at,receipt_json FROM workspace_executions WHERE operation_id=?',
      [operationId],
    );
  }
  async begin(
    operationId: string,
    input: PreparedExecution,
  ): Promise<StoredExecution> {
    await this.setup();
    const prepared = binding(input);
    if (operationId !== prepared.request.requestId)
      throw new Error('Operation ID must match the prepared execution');
    return this.db.transaction(async () => {
      const row = await this.row(operationId);
      if (row) {
        if (
          canonicalArguments(JSON.parse(row.binding_json)) !==
          canonicalArguments(prepared)
        )
          throw new Error('Execution is bound to different prepared input');
        const receipt = boundReceipt(row);
        if (row.state === 'completed' && receipt)
          return {
            state: 'completed',
            binding: prepared,
            startedAt: row.started_at,
            receipt,
          };
        await this.db.run(
          "UPDATE workspace_executions SET state='unknown' WHERE operation_id=?",
          [operationId],
        );
        return {
          state: 'unknown',
          binding: prepared,
          startedAt: row.started_at,
          receipt,
        };
      }
      const startedAt = new Date().toISOString();
      await this.db.run(
        "INSERT INTO workspace_executions(operation_id,input_digest,binding_json,state,started_at) VALUES (?,?,?,'running',?)",
        [
          operationId,
          prepared.request.inputDigest,
          canonicalArguments(prepared),
          startedAt,
        ],
      );
      return { state: 'started', binding: prepared, startedAt };
    });
  }
  async read(
    operationId: string,
    digest: string,
    principalDID: string,
    workRef: string,
  ): Promise<StoredExecution | null> {
    const row = await this.row(operationId);
    if (!row) return null;
    const prepared = binding(JSON.parse(row.binding_json));
    if (
      prepared.request.inputDigest !== digest ||
      prepared.request.principalDID !== principalDID ||
      prepared.request.workRef !== workRef ||
      prepared.request.requestId !== operationId
    )
      throw new Error('Stored execution binding mismatch');
    const receipt = boundReceipt(row);
    return {
      binding: prepared,
      state: row.state === 'completed' && receipt ? 'completed' : 'unknown',
      startedAt: row.started_at,
      receipt,
    };
  }
  async record(operationId: string, receipt: ExecutionReceipt): Promise<void> {
    await this.setup();
    const parsed = ExecutionReceiptSchema.parse(receipt);
    await this.db.transaction(async () => {
      const row = await this.row(operationId);
      if (!row) throw new Error('Execution has not been prepared');
      boundReceipt({ ...row, receipt_json: JSON.stringify(parsed) });
      if (
        row.receipt_json &&
        canonicalArguments(JSON.parse(row.receipt_json)) !==
          canonicalArguments(parsed)
      )
        throw new Error('Execution already has a different receipt');
      await this.db.run(
        'UPDATE workspace_executions SET state=?,receipt_json=? WHERE operation_id=?',
        [parsed.status, JSON.stringify(parsed), operationId],
      );
    });
  }
}
