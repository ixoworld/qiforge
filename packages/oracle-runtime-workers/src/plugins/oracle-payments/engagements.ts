import { z } from 'zod';
import type { UserKvSurface } from '../../plugin-api/types';

/**
 * The user's paid job, in their own database (`ctx.kv`). The user's object
 * is one per user, and the chain allows one live claim intent per (agent,
 * collection), so a single `engagement` row per user is the whole model:
 * present = a job is reserved and not yet settled.
 */

const NAMESPACE = 'oracle-payments';
const ACTIVE_KEY = 'engagement';
const LAST_KEY = 'last-settled';

const CoinSchema = z.object({ denom: z.string(), amount: z.string() });

const EngagementSchema = z.object({
  status: z.enum(['active', 'delivered', 'closed']),
  serviceId: z.string(),
  serviceName: z.string(),
  priceUsd: z.number(),
  collectionId: z.string(),
  adminAddress: z.string(),
  userDid: z.string(),
  startedAt: z.string(),
  amount: CoinSchema,
  homeServer: z.string().nullable(),
  intentTxHash: z.string(),
  /** The user's own words that opened the job — never the agent's. */
  request: z.string(),
  /** Set once the claim body is saved, so a failed submit resumes without re-uploading. */
  claimId: z.string().optional(),
  cancelledAt: z.string().optional(),
  cancelReason: z.string().optional(),
});

export type Engagement = z.infer<typeof EngagementSchema>;

const SettledSchema = z.object({
  serviceName: z.string(),
  outcome: z.enum(['delivered', 'cancelled']),
  claimId: z.string(),
  txHash: z.string(),
  settledAt: z.string(),
});

export type Settled = z.infer<typeof SettledSchema>;

export class EngagementStore {
  constructor(private readonly kv: UserKvSurface) {}

  async active(): Promise<Engagement | null> {
    const parsed = EngagementSchema.safeParse(
      await this.kv.get(NAMESPACE, ACTIVE_KEY),
    );
    return parsed.success ? parsed.data : null;
  }

  async save(engagement: Engagement): Promise<void> {
    await this.kv.set(NAMESPACE, ACTIVE_KEY, engagement);
  }

  /** Close the job: drop the active row, keep a one-line record of how it ended. */
  async settle(settled: Settled): Promise<void> {
    await this.kv.delete(NAMESPACE, ACTIVE_KEY);
    await this.kv.set(NAMESPACE, LAST_KEY, settled);
  }

  async lastSettled(): Promise<Settled | null> {
    const parsed = SettledSchema.safeParse(
      await this.kv.get(NAMESPACE, LAST_KEY),
    );
    return parsed.success ? parsed.data : null;
  }
}
