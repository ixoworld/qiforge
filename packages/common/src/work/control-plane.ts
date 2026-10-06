import { z } from 'zod';
import {
  PortableWorkScalarSchema,
  PORTABLE_WORK_RESERVED_CONFIGURATION_KEYS,
} from './portable-work.js';

const text = z.string().min(1).max(2048);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const did = z.string().regex(/^did:/).max(255);
const unique = (values: readonly string[]) =>
  new Set(values).size === values.length;
const names = z
  .array(
    z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
      .max(128),
  )
  .max(64)
  .refine(unique);
export const CapabilityRequirementSchema = z
  .object({ with: text, can: text })
  .strict();
export const PrivilegePlaneSchema = z.enum(['orchestration', 'admin']);
export const ConsequenceClassSchema = z.enum([
  'none',
  'shared-state',
  'external-effect',
  'settlement',
]);
export const SkillManifestSchema = z
  .object({
    version: z.literal(1),
    skillId: text,
    skillVersion: text,
    digest,
    acceptedWorkTypes: z.array(text).min(1).max(32).refine(unique),
    requiredCapabilities: z.array(CapabilityRequirementSchema).max(64),
    privilegePlanes: z.array(PrivilegePlaneSchema).min(1).max(2).refine(unique),
    execution: z
      .object({
        targetKinds: z
          .array(z.enum(['sandbox', 'worker', 'computer', 'local']))
          .min(1)
          .max(4)
          .refine(unique),
        entrypoint: z
          .string()
          .regex(/^[A-Za-z0-9_./-]+$/)
          .max(255)
          .refine(
            (path) => !path.startsWith('/') && !path.split('/').includes('..'),
          ),
        timeoutMs: z.number().int().positive().max(180000),
        requiredCredentialNames: names,
      })
      .strict(),
    outputs: z
      .array(z.object({ name: text, mediaType: text, path: text }).strict())
      .max(32),
    consequence: ConsequenceClassSchema,
    provenance: z.object({ publisherDid: did, sourceRef: text }).strict(),
  })
  .strict();
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export const WakeSubscriptionSchema = z
  .object({
    version: z.literal(1),
    subscriptionId: text,
    principalDID: did,
    source: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('schedule'),
          schedule: z.string().min(1).max(255),
        })
        .strict(),
      z
        .object({ kind: z.literal('topic'), roomId: text, topicId: text })
        .strict(),
    ]),
    resourceRef: text,
    filter: z
      .object({ eventTypes: z.array(text).max(32).refine(unique) })
      .strict(),
    cursor: text.optional(),
    deliveryPolicy: z.enum(['notify', 'evaluate']),
    expiresAt: z.string().datetime(),
    state: z.enum(['active', 'revoked']),
    createdAt: z.string().datetime(),
  })
  .strict();
export type WakeSubscription = z.infer<typeof WakeSubscriptionSchema>;

export const ArtifactRefSchema = z
  .object({
    resource: text,
    fileId: text,
    version: z.number().int().positive(),
    cid: text,
    sha256: digest,
    name: text,
    path: text,
    mediaType: text,
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const ExecutionTargetDescriptorSchema = z
  .object({
    version: z.literal(1),
    providerId: text,
    targetId: text,
    kind: z.enum(['sandbox', 'worker', 'computer', 'local']),
    capabilities: z.array(text).max(64).refine(unique),
    isolation: z.enum(['principal', 'execution']),
    locality: z.enum(['remote', 'operator']),
    lifecycle: z.enum(['ephemeral', 'persistent']),
  })
  .strict();
export type ExecutionTargetDescriptor = z.infer<
  typeof ExecutionTargetDescriptorSchema
>;

export const ExecutionRequestSchema = z
  .object({
    version: z.literal(1),
    requestId: text,
    principalDID: did,
    workRef: text,
    operation: z.enum(['skill', 'research']),
    inputDigest: digest,
    inputs: z
      .record(z.string(), PortableWorkScalarSchema)
      .refine(
        (inputs) =>
          !Object.keys(inputs).some((key) =>
            PORTABLE_WORK_RESERVED_CONFIGURATION_KEYS.some(
              (reserved) => reserved === key,
            ),
          ),
        { message: 'Execution inputs cannot carry authority or credentials' },
      ),
    artifacts: z.array(ArtifactRefSchema).max(32),
    timeoutMs: z.number().int().positive().max(180000),
    requestedCapabilities: z.array(CapabilityRequirementSchema).max(64),
  })
  .strict();
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;

export const ExecutionReceiptSchema = z
  .object({
    version: z.literal(1),
    providerId: text,
    targetId: text,
    requestId: text,
    principalDID: did,
    workRef: text,
    inputDigest: digest,
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    status: z.enum(['completed', 'failed', 'cancelled', 'unknown']),
    artifacts: z.array(ArtifactRefSchema).max(32),
    evidenceRefs: z.array(text).max(64),
    result: z.string().max(128000).optional(),
    failure: z.string().max(4000).optional(),
  })
  .strict();
export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;

export const ActionRequestSchema = z
  .object({
    version: z.literal(1),
    actionId: text,
    principalDID: did,
    resourceRef: text,
    inputDigest: digest,
    privilegePlane: PrivilegePlaneSchema,
    consequence: ConsequenceClassSchema,
    requiredCapabilities: z.array(CapabilityRequirementSchema).max(64),
    evidenceRefs: z.array(text).max(64),
    decisionRefs: z.array(text).max(64),
  })
  .strict();
export type ActionRequest = z.infer<typeof ActionRequestSchema>;
export const ConsequenceDecisionSchema = z
  .object({
    version: z.literal(1),
    actionId: text,
    inputDigest: digest,
    decision: z.enum(['allow', 'deny', 'review']),
    policyVersion: text,
    reason: text,
    determinationRef: text.optional(),
  })
  .strict();
export type ConsequenceDecision = z.infer<typeof ConsequenceDecisionSchema>;

export const WorkspaceBindingSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    principalDID: did,
    resourceRef: text,
    rootPath: z.string().regex(/^\/\.workspaces\/[A-Za-z0-9_-]+\/$/),
  })
  .strict();
export type WorkspaceBinding = z.infer<typeof WorkspaceBindingSchema>;
export const WorkspaceRevisionSchema = z
  .object({
    version: z.literal(1),
    workspaceId: text,
    revision: digest,
    parentRevision: digest.optional(),
    artifacts: z.array(ArtifactRefSchema).max(32),
    createdAt: z.string().datetime(),
    provenance: z
      .object({
        principalDID: did,
        workRef: text,
        inputDigest: digest,
        message: text,
      })
      .strict(),
  })
  .strict();
export type WorkspaceRevision = z.infer<typeof WorkspaceRevisionSchema>;
