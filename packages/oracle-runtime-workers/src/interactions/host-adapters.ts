import type { RuntimeContext } from '../plugin-api/types';

/** Hosts call this only after persistence, using the store's confirmed reference. */
export function reportPersistedArtifact(
  ctx: Pick<RuntimeContext, 'interactions'>,
  artifact: { artifactId: string },
): void {
  if (artifact.artifactId.trim())
    ctx.interactions?.verifiedAchievement({
      kind: 'artifact',
      reference: artifact.artifactId,
    });
}

/** A task adapter supplies a verified completion receipt, never generated text or a tool status. */
export function reportVerifiedTaskCompletion(
  ctx: Pick<RuntimeContext, 'interactions'>,
  result: {
    taskId: string;
    status: 'completed' | 'failed' | 'pending';
    completionReceipt?: string;
  },
): boolean {
  if (
    result.status !== 'completed' ||
    !result.taskId.trim() ||
    !result.completionReceipt?.trim()
  )
    return false;
  ctx.interactions?.verifiedAchievement({
    kind: 'task',
    reference: result.completionReceipt,
  });
  return true;
}

/** Scope to an actual input/approval wait; typing resumes when that wait settles. */
export async function withHumanInput<T>(
  ctx: Pick<RuntimeContext, 'interactions'>,
  wait: () => Promise<T>,
): Promise<T> {
  ctx.interactions?.setWaiting(true);
  try {
    return await wait();
  } finally {
    ctx.interactions?.setWaiting(false);
  }
}
