import { defineDecision } from '@ixo/common';
import { z } from 'zod';

export const COMMERCE_ROUTE_DECISION_NAME = 'oracle-payments.route-message';

const routedServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  examples: z.array(z.string()).optional(),
});

export const commerceRouteDecision = defineDecision({
  name: COMMERCE_ROUTE_DECISION_NAME,
  version: '1.0.0',
  description:
    'Judge whether a Matrix turn requests paid work now and which published service it matches.',
  inputSchema: z.object({
    text: z.string(),
    services: z.array(routedServiceSchema).min(1),
  }),
  project(input) {
    const noneOption = noMatchingServiceOption(input.services.map((s) => s.id));

    return {
      state: {
        message: input.text,
        services: input.services.map((service) => ({
          id: service.id,
          name: service.name,
          ...(service.description ? { description: service.description } : {}),
          ...(service.tags?.length ? { tags: service.tags } : {}),
          ...(service.examples?.length ? { examples: service.examples } : {}),
        })),
      },
      questions: {
        workRequestedNow: {
          kind: 'boolean',
          instructions:
            'Is the user clearly asking the agent to perform one of the listed paid services now?',
          criteria: {
            true:
              'The user is requesting execution of a listed service now.',
            false:
              'The user is asking about capabilities, pricing, contracting, status, making conversation, or otherwise not clearly requesting execution now.',
          },
        },
        service: {
          kind: 'choice',
          instructions:
            'Which single listed paid service best matches the work the user is asking to have performed?',
          options: {
            ...Object.fromEntries(
              input.services.map((service) => [
                service.id,
                describeService(service),
              ]),
            ),
            [noneOption]: 'No single listed service clearly matches.',
          },
        },
      },
    };
  },
});

function describeService(service: z.infer<typeof routedServiceSchema>): string {
  const parts = [service.name];
  if (service.description) parts.push(service.description);
  if (service.tags?.length) parts.push(`Tags: ${service.tags.join(', ')}`);
  if (service.examples?.length) {
    parts.push(`Examples: ${service.examples.join('; ')}`);
  }
  return parts.join(' — ');
}

function noMatchingServiceOption(serviceIds: string[]): string {
  let candidate = '__no_matching_service__';
  while (serviceIds.includes(candidate)) candidate = `_${candidate}`;
  return candidate;
}
