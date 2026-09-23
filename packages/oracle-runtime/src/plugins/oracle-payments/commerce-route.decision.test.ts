import { describe, expect, it } from 'vitest';
import { commerceRouteDecision } from './commerce-route.decision.js';

describe('commerceRouteDecision', () => {
  it('projects only routing-relevant service fields and bounded questions', () => {
    const request = commerceRouteDecision.prepare({
      text: 'File my taxes now',
      services: [
        {
          id: 'tax-report',
          name: 'Tax report',
          description: 'Annual filing',
          tags: ['tax'],
          examples: ['File my 2025 taxes'],
        },
      ],
    });

    expect(request.state).toEqual({
      message: 'File my taxes now',
      services: [
        {
          id: 'tax-report',
          name: 'Tax report',
          description: 'Annual filing',
          tags: ['tax'],
          examples: ['File my 2025 taxes'],
        },
      ],
    });

    expect(request.questions.workRequestedNow).toMatchObject({
      kind: 'boolean',
    });
    expect(request.questions.service).toMatchObject({
      kind: 'choice',
      options: {
        'tax-report': expect.any(String),
        __no_matching_service__: expect.any(String),
      },
    });
  });

  it('chooses a collision-free no-match option', () => {
    const request = commerceRouteDecision.prepare({
      text: 'Do something',
      services: [
        {
          id: '__no_matching_service__',
          name: 'Odd but valid service id',
        },
      ],
    });

    expect(request.questions.service).toMatchObject({
      kind: 'choice',
      options: {
        __no_matching_service__: expect.any(String),
        ___no_matching_service__: expect.any(String),
      },
    });
  });
});
