import { type INestApplication, Logger } from '@nestjs/common';
import type { MatrixManager } from '@ixo/matrix';
import { UserMatrixSqliteSyncService } from '../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';

export interface GracefulShutdownOptions {
  app: INestApplication;
  matrixManager: MatrixManager;
  /** Optional teardown callbacks run after Nest has stopped but before exit. */
  teardown?: Array<() => Promise<void> | void>;
  /** Signals to listen on; defaults to SIGTERM + SIGINT. */
  signals?: NodeJS.Signals[];
}

const DEFAULT_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/**
 * Drain the running Nest app on SIGTERM/SIGINT: upload checkpoints to Matrix,
 * close the HTTP server, then shut down the Matrix client. Mirrors today's
 * boot flow so existing operators see no behaviour change when migrating.
 *
 * Each step is wrapped individually — an error in one step is logged and the
 * remaining steps still run.
 */
export function registerGracefulShutdown(
  opts: GracefulShutdownOptions,
): () => void {
  const context = 'GracefulShutdown';
  const signals = opts.signals ?? DEFAULT_SIGNALS;

  const handlers = new Map<NodeJS.Signals, (signal: NodeJS.Signals) => void>();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    Logger.log(`${signal} received, starting graceful shutdown...`, context);

    await runStep('Upload checkpoint to Matrix', async () => {
      const syncService = opts.app.get(UserMatrixSqliteSyncService);
      await syncService.uploadCheckpointToMatrixStorageTask();
    });

    await runStep('Stop Nest application', async () => {
      await opts.app.close();
    });

    await runStep('Stop MatrixManager client', async () => {
      await opts.matrixManager.shutdown();
    });

    for (const teardownFn of opts.teardown ?? []) {
      await runStep('Run plugin teardown', () => teardownFn());
    }

    Logger.log('Graceful shutdown complete', context);
    process.exit(0);
  };

  for (const signal of signals) {
    const handler = (received: NodeJS.Signals): void => {
      shutdown(received).catch((err: unknown) => {
        Logger.error(
          'Error during graceful shutdown',
          err instanceof Error ? err.stack : String(err),
          context,
        );
        process.exit(1);
      });
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  // Return a detach function for tests that need to remove the handlers.
  return (): void => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}

async function runStep(
  label: string,
  step: () => Promise<void> | void,
): Promise<void> {
  const context = 'GracefulShutdown';
  Logger.log(`${label}...`, context);
  try {
    await step();
    Logger.log(`${label} complete`, context);
  } catch (err: unknown) {
    Logger.warn(
      `${label} failed (continuing anyway): ${
        err instanceof Error ? err.message : String(err)
      }`,
      context,
    );
  }
}
