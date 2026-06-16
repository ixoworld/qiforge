import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullModule } from '@nestjs/bullmq';
import { Module, type DynamicModule } from '@nestjs/common';

/**
 * Base route the bull-board UI mounts on. Exported so main.ts can derive the
 * auth exclusions and the boot log from one source of truth.
 */
export const TASKS_DASHBOARD_ROUTE = '/admin/queues';

// Hardcoded copies of the tasks plugin's internal queue names. The plugin
// does not export them, so keep these in sync with RUN_QUEUE / APPROVAL_QUEUE
// in packages/oracle-runtime/src/plugins/tasks/internal/scheduler.ts.
const RUN_QUEUE = 'task_run';
const APPROVAL_QUEUE = 'task_approval';

/**
 * Development-only BullMQ dashboard for the tasks plugin's two queues.
 *
 * Registers the queues with an explicit connection (rather than relying on
 * the runtime's internal Bull root config) so this module is self-contained:
 * it works regardless of how — or whether — the tasks plugin configured
 * BullMQ inside the runtime's module graph. Both registrations point at the
 * same Redis, so the dashboard sees exactly the jobs the plugin schedules.
 *
 * All five packages this file imports are devDependencies — production
 * installs never ship them. See main.ts for the NODE_ENV-guarded dynamic
 * import that keeps this module out of deployed builds.
 */
@Module({})
export class TasksDashboardModule {
  static register(redisUrl: string): DynamicModule {
    return {
      module: TasksDashboardModule,
      imports: [
        BullModule.registerQueue(
          { name: RUN_QUEUE, connection: { url: redisUrl } },
          { name: APPROVAL_QUEUE, connection: { url: redisUrl } },
        ),
        BullBoardModule.forRoot({
          route: TASKS_DASHBOARD_ROUTE,
          adapter: ExpressAdapter,
        }),
        BullBoardModule.forFeature(
          { name: RUN_QUEUE, adapter: BullMQAdapter },
          { name: APPROVAL_QUEUE, adapter: BullMQAdapter },
        ),
      ],
    };
  }
}
