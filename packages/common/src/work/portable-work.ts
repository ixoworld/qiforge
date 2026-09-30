import { z } from 'zod';

export const PortableWorkScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const PortableWorkDefinitionSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1).max(160),
    intent: z.string().min(1),
    outcome: z.string().min(1).optional(),
    definitionOfDone: z.array(z.string().min(1)).optional(),
    rubricRefs: z.array(z.string().min(1)).optional(),
    suggestedRoles: z.array(z.string().min(1)).optional(),
    suggestedCapabilities: z.array(z.string().min(1)).optional(),
    configurationDefaults: z
      .record(z.string(), PortableWorkScalarSchema)
      .optional(),
  })
  .strict();

export type PortableWorkScalar = z.infer<typeof PortableWorkScalarSchema>;
export type PortableWorkDefinition = z.infer<
  typeof PortableWorkDefinitionSchema
>;
