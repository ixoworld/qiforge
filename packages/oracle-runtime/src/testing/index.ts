import type { OraclePlugin } from '../plugin-api/oracle-plugin.js';
import type { RuntimeContext } from '../plugin-api/types.js';

export interface TestRuntime {
  /** Drive a tool call through the test harness. */
  invokeTool: (toolName: string, args: unknown) => Promise<unknown>;
  /** Inspect the synthesized RuntimeContext used by the harness. */
  readonly ctx: RuntimeContext;
  /** Tear down anything the harness allocated. */
  dispose: () => Promise<void>;
}

export interface CreateTestRuntimeOptions {
  plugins: OraclePlugin[];
  ctx?: Partial<RuntimeContext>;
}

export function createTestRuntime(_options: CreateTestRuntimeOptions): TestRuntime {
  throw new Error('not implemented');
}

export function mockResponse(_content: string): unknown {
  throw new Error('not implemented');
}

export function mockStream(_chunks: string[]): unknown {
  throw new Error('not implemented');
}
