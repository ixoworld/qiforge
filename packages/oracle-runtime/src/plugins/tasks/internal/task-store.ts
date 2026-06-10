import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  parseSpec,
  renderSpec,
  specPath,
  userTasksPrefix,
  type TaskSpec,
  type TaskStatus,
} from './spec.js';
import { TASK_FS, type TaskFs } from './task-fs.js';

/**
 * Spec CRUD on top of the `TaskFs` port. Every parse/render/path concern
 * lives here so tools and workers never touch raw markdown.
 */
@Injectable()
export class TaskStore {
  private readonly logger = new Logger(TaskStore.name);

  constructor(@Inject(TASK_FS) private readonly fs: TaskFs) {}

  async load(owner: string, taskId: string): Promise<TaskSpec | null> {
    const markdown = await this.fs.read(specPath(owner, taskId));
    if (!markdown) return null;
    return parseSpec(markdown);
  }

  async save(spec: TaskSpec): Promise<void> {
    await this.fs.write(
      specPath(spec.frontmatter.owner, spec.frontmatter.id),
      renderSpec(spec),
    );
  }

  /** All of a user's tasks. Specs that fail to parse are skipped with a warning. */
  async list(owner: string): Promise<TaskSpec[]> {
    const paths = await this.fs.list(userTasksPrefix(owner));
    const specs: TaskSpec[] = [];
    for (const path of paths.filter((p) => p.endsWith('/spec.md'))) {
      const markdown = await this.fs.read(path);
      if (!markdown) continue;
      try {
        specs.push(parseSpec(markdown));
      } catch (err) {
        this.logger.warn(
          `Skipping unparseable spec at ${path}: ${(err as Error).message}`,
        );
      }
    }
    return specs;
  }

  /**
   * Transition a task's status (+ next-run bookkeeping) and persist.
   * Returns the updated spec, or null when the task doesn't exist.
   */
  async setStatus(
    owner: string,
    taskId: string,
    status: TaskStatus,
    nextRunAt: string | null,
  ): Promise<TaskSpec | null> {
    const spec = await this.load(owner, taskId);
    if (!spec) return null;
    const updated: TaskSpec = {
      ...spec,
      frontmatter: { ...spec.frontmatter, status, stats: { nextRunAt } },
    };
    await this.save(updated);
    return updated;
  }
}
