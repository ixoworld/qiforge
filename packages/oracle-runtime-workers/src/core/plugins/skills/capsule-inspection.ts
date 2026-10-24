import { CID } from 'multiformats/cid';
import { z } from 'zod';
import type { PluginTool, RuntimeContext } from '../../../plugin-api/types';
import { toolEffectOf } from '../../middlewares/tool-marks';
import { capsuleContractSchema, type SkillContract } from './skill-contract';
import type { SkillsUcanBuilder } from './skills-tools';

export const skillCidSchema = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      CID.parse(value);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid capsule CID');

export const inspectionArgsSchema = z.strictObject({
  cid: skillCidSchema,
  path: z.string().min(1).max(256).optional(),
});

const inspectionSchema = z.object({
  cid: skillCidSchema,
  visibility: z.enum(['public', 'private']),
  skillName: z.string().min(1).max(64),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  archiveSize: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
  declaration: capsuleContractSchema,
  document: z
    .object({
      path: z.string().max(256),
      text: z.string().max(65536),
    })
    .optional(),
});

export type CapsuleInspection = z.infer<typeof inspectionSchema>;
export interface InspectionClientOptions {
  baseUrl: string;
  network: string;
  ucanBuilder: SkillsUcanBuilder;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Missing inspection body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512 * 1024) throw new Error('Inspection response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
  );
}

export async function inspectCapsule(
  args: z.infer<typeof inspectionArgsSchema>,
  ctx: RuntimeContext,
  options: InspectionClientOptions,
): Promise<CapsuleInspection> {
  const url = new URL(
    `/capsules/${encodeURIComponent(args.cid)}/inspect`,
    options.baseUrl,
  );
  if (args.path !== undefined) url.searchParams.set('path', args.path);
  const invocation =
    (await currentSkillAudience(ctx)) === 'private'
      ? await options.ucanBuilder(options.baseUrl, ctx)
      : undefined;
  const response = await fetch(url, {
    headers: {
      'X-IXO-Network': options.network,
      ...(invocation
        ? { Authorization: `Bearer ${invocation}`, 'X-Auth-Type': 'ucan' }
        : {}),
    },
    redirect: 'manual',
    signal: ctx.abortSignal
      ? AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Capsule inspection unavailable');
  const inspected = inspectionSchema.parse(await boundedJson(response));
  if (inspected.cid !== args.cid) throw new Error('Inspection CID mismatch');
  if (
    inspected.declaration.status === 'validated' &&
    inspected.declaration.contract.skillName !== inspected.skillName
  ) {
    throw new Error('Inspection skill name mismatch');
  }
  if (
    args.path !== inspected.document?.path &&
    (args.path !== undefined || inspected.document !== undefined)
  ) {
    throw new Error('Inspection document mismatch');
  }
  if (
    inspected.document &&
    new TextEncoder().encode(inspected.document.text).length > 65536
  ) {
    throw new Error('Inspection document too large');
  }
  return inspected;
}

export async function currentSkillAudience(
  ctx: RuntimeContext,
): Promise<'private' | 'shared'> {
  try {
    return (await ctx.skillAudience?.()) ?? 'shared';
  } catch {
    return 'shared';
  }
}

export function assessSkillRequirements(
  contract: SkillContract,
  tools: readonly PluginTool[],
  audience: 'private' | 'shared',
  hasCapability: RuntimeContext['ucan']['hasCapability'],
): string[] {
  const reasons: string[] = [];
  if (contract.runtime !== 'qiforge-workers')
    reasons.push('unsupported_runtime');
  if (!contract.audiences.includes(audience))
    reasons.push('audience_not_allowed');
  const inventory = new Map(tools.map((entry) => [entry.name, entry]));
  for (const required of contract.requiredTools) {
    const present = inventory.get(required.name);
    if (!present) reasons.push(`missing_tool:${required.name}`);
    else if (toolEffectOf(present) !== required.effect)
      reasons.push(`tool_effect_mismatch:${required.name}`);
  }
  for (const required of contract.requiredCapabilities) {
    if (!hasCapability(required.resource, required.action))
      reasons.push(
        `missing_capability:${required.resource}:${required.action}`,
      );
  }
  for (const required of contract.requiredServices) {
    reasons.push(
      `unsupported_service_profile:${required.id}:${required.profile}`,
    );
  }
  return reasons;
}

export async function inspectSkillReference(
  rawArgs: unknown,
  ctx: RuntimeContext,
  options: InspectionClientOptions,
): Promise<unknown> {
  const args = inspectionArgsSchema.parse(rawArgs);
  try {
    const inspected = await inspectCapsule(args, ctx, options);
    if (
      inspected.visibility === 'private' &&
      (await currentSkillAudience(ctx)) !== 'private'
    ) {
      return { status: 'blocked', reasons: ['private_reference_unavailable'] };
    }
    return {
      ...inspected,
      status: 'reference_only',
      execution: 'unchecked',
      effectEnforced: false,
      mountIntegrity: 'unverified',
    };
  } catch {
    return { status: 'blocked', reasons: ['inspection_unavailable'] };
  }
}

export function guardSkillExecution(
  original: PluginTool,
  inventory: (ctx: RuntimeContext) => Promise<PluginTool[]>,
  inspect: PluginTool['handler'] | undefined,
): PluginTool {
  if (original.name !== 'load_skill' && original.name !== 'sandbox_run')
    return original;
  const argsSchema = z.object({ cid: skillCidSchema.optional() }).passthrough();
  return {
    ...original,
    schema: z.intersection(original.schema, argsSchema),
    handler: async (rawArgs, ctx) => {
      const parsed = argsSchema.safeParse(rawArgs);
      if (!parsed.success)
        return { status: 'blocked', reasons: ['invalid_skill_arguments'] };
      if (
        Object.keys(parsed.data).some((key) =>
          ['skillCid', 'skill_cid', 'capsuleCid', 'capsule_cid'].includes(key),
        )
      ) {
        return { status: 'blocked', reasons: ['unsupported_cid_argument'] };
      }
      const cid = parsed.data.cid;
      if (!cid && original.name === 'sandbox_run')
        return original.handler(rawArgs, ctx);
      if (!cid) return { status: 'blocked', reasons: ['capsule_cid_required'] };
      if (!inspect)
        return { status: 'blocked', reasons: ['inspection_unavailable'] };
      let inspected: CapsuleInspection;
      try {
        inspected = inspectionSchema.parse(await inspect({ cid }, ctx));
        if (inspected.cid !== cid) throw new Error('Inspection CID mismatch');
        const audience = await currentSkillAudience(ctx);
        if (inspected.visibility === 'private' && audience !== 'private') {
          return {
            status: 'blocked',
            reasons: ['private_reference_unavailable'],
          };
        }
        if (inspected.declaration.status !== 'validated') {
          return {
            status: 'reference_only',
            reasons: [`${inspected.declaration.status}_contract`],
            effectEnforced: false,
            mountIntegrity: 'unverified',
          };
        }
        const tools = await inventory(ctx);
        const reasons = assessSkillRequirements(
          inspected.declaration.contract,
          tools,
          audience,
          ctx.ucan.hasCapability,
        );
        const latestAudience = await currentSkillAudience(ctx);
        if (latestAudience !== audience) reasons.push('audience_changed');
        if (reasons.length) return { status: 'blocked', reasons };
      } catch {
        return { status: 'blocked', reasons: ['inspection_unavailable'] };
      }
      const result = await original.handler(rawArgs, ctx);
      const check = {
        status: 'dependencies_checked',
        effectEnforced: false,
        mountIntegrity: 'unverified',
        authorization: 'host_tool_checks_required',
        cid: inspected.cid,
      };
      const objectResult = z.record(z.string(), z.unknown()).safeParse(result);
      return objectResult.success
        ? { ...objectResult.data, skillContractCheck: check }
        : result;
    },
  };
}
