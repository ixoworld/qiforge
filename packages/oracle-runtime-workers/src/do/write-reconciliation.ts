import { z } from 'zod';

export const WriteFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const WriteReconciliationSchema = z
  .object({
    expectedRunId: z.string().min(1).max(255),
    evidenceRef: z.string().min(1).max(2048),
    outcome: z.enum(['applied', 'not-applied', 'unknown']),
    authorizeRetry: z.boolean(),
  })
  .strict()
  .refine(
    (value) => !value.authorizeRetry || value.outcome === 'not-applied',
    'Retry requires evidence that the original effect was not applied',
  );
export type WriteReconciliation = z.infer<typeof WriteReconciliationSchema>;
