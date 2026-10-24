import { z } from 'zod';

const identifier = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/);
const unique = <T>(values: T[]) => new Set(values).size === values.length;

export const skillContractSchema = z.strictObject({
  schemaVersion: z.literal(1),
  skillName: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  runtime: z.enum(['qiforge-workers', 'external']),
  audiences: z.array(z.enum(['private', 'shared'])).min(1).max(2).refine(unique),
  effects: z.array(z.enum(['read', 'stage', 'write', 'payment'])).min(1).max(4).refine(unique),
  requiredTools: z.array(z.strictObject({
    name: identifier,
    effect: z.enum(['read', 'write']),
  })).max(32).refine(values => unique(values.map(value => value.name))),
  requiredCapabilities: z.array(z.strictObject({
    resource: z.string().min(1).max(256).startsWith('ixo:'),
    action: z.string().min(1).max(128),
  })).max(20).refine(values => unique(values.map(value => `${value.resource}\u0000${value.action}`))),
  requiredServices: z.array(z.strictObject({
    id: identifier,
    profile: identifier,
  })).max(10).refine(values => unique(values.map(value => value.id))),
});

export type SkillContract = z.infer<typeof skillContractSchema>;

export const capsuleContractSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('validated'), contract: skillContractSchema }),
  z.strictObject({ status: z.literal('legacy') }),
  z.strictObject({ status: z.literal('unsupported') }),
]);

export type CapsuleContract = z.infer<typeof capsuleContractSchema>;

export function parseCapsuleContract(text: string | undefined, skillName: string): CapsuleContract {
  if (text === undefined) return { status: 'legacy' };
  const input: unknown = JSON.parse(text);
  const version = z.object({ schemaVersion: z.number().int().positive() }).parse(input);
  if (version.schemaVersion !== 1) return { status: 'unsupported' };
  const contract = skillContractSchema.parse(input);
  if (contract.skillName !== skillName) throw new Error('Contract skillName does not match capsule root');
  return { status: 'validated', contract };
}
