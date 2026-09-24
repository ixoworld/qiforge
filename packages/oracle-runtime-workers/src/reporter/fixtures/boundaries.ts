import {
  jsonBytes,
  type Snapshot,
  type Narrative,
  type HistoryTurn,
} from '../contracts';

function fill(
  target: number,
  value: unknown,
  append: (text: string) => void,
): void {
  while (jsonBytes(value) < target) {
    const before = jsonBytes(value);
    append('');
    const overhead = jsonBytes(value) - before;
    const remaining = target - before - overhead;
    if (remaining < 0) throw new Error('Fixture cannot reach byte boundary');
    append('x'.repeat(Math.min(4096, remaining)));
  }
  if (jsonBytes(value) !== target) throw new Error('Fixture exceeds boundary');
}
export function boundaryFixtures() {
  const snapshot: Snapshot = {
    version: 1,
    digest: 'a'.repeat(64),
    certificateDigest: 'b'.repeat(64),
    capturedAt: '2026-09-24T10:00:00.000Z',
    title: 'Synthetic boundary certificate',
    facts: [],
    checks: [],
    disclaimer: 'Synthetic fixture only',
  };
  let factIndex = 0;
  fill(65536, snapshot, (text) => {
    if (text === '')
      snapshot.facts.push({
        nodeId: `n${factIndex++}`,
        property: 'p',
        value: '',
        unit: null,
      });
    else snapshot.facts[snapshot.facts.length - 1]!.value = text;
  });
  const narrative: Narrative = {
    version: 1,
    snapshotDigest: snapshot.digest,
    sections: [{ topic: 'explanation', units: [] }],
  };
  const addText = (text: string) => {
    if (text === '')
      narrative.sections[0]!.units.push({
        kind: 'interpretation',
        text: '',
        refs: [{ nodeId: 'n0', property: 'p' }],
      });
    else {
      const unit = narrative.sections[0]!.units.at(-1)!;
      if (unit.kind === 'interpretation') unit.text = text;
    }
  };
  fill(65536, narrative, addText);
  const history: HistoryTurn[] = [
    { message: 'Synthetic question', narrative: structuredClone(narrative) },
  ];
  const last = history[0]!.narrative.sections[0]!.units.at(-1)!;
  if (last.kind !== 'interpretation') throw new Error('Wrong boundary unit');
  last.text = last.text.slice(
    0,
    last.text.length - (jsonBytes(history) - 65536),
  );
  return { snapshot, narrative, history };
}

export function fieldBoundaryFixtures() {
  const fact = { nodeId: 'n', property: 'p', value: 'v', unit: null };
  const snapshot: Snapshot = {
    version: 1,
    digest: 'a'.repeat(64),
    certificateDigest: 'b'.repeat(64),
    capturedAt: '2026-09-24T10:00:00.000Z',
    title: 't',
    facts: [fact],
    checks: [],
    disclaimer: 'd',
  };
  const narrative: Narrative = {
    version: 1,
    snapshotDigest: snapshot.digest,
    sections: [
      {
        topic: 'what',
        units: [{ kind: 'missing', text: 'This information is not recorded' }],
      },
    ],
  };
  const cases: Array<{
    name: string;
    schema: 'snapshot' | 'narrative' | 'history';
    accepted: unknown;
    rejected: unknown;
  }> = [];
  for (const key of ['nodeId', 'property', 'value', 'unit'] as const) {
    cases.push({
      name: `fact-${key}`,
      schema: 'snapshot',
      accepted: { ...snapshot, facts: [{ ...fact, [key]: 'x'.repeat(4096) }] },
      rejected: { ...snapshot, facts: [{ ...fact, [key]: 'x'.repeat(4097) }] },
    });
  }
  for (const key of ['title', 'disclaimer'] as const) {
    cases.push({
      name: `snapshot-${key}`,
      schema: 'snapshot',
      accepted: { ...snapshot, [key]: 'x'.repeat(4096) },
      rejected: { ...snapshot, [key]: 'x'.repeat(4097) },
    });
  }
  cases.push({
    name: 'check-id',
    schema: 'snapshot',
    accepted: {
      ...snapshot,
      checks: [{ id: 'x'.repeat(4096), status: 'passed' }],
    },
    rejected: {
      ...snapshot,
      checks: [{ id: 'x'.repeat(4097), status: 'passed' }],
    },
  });
  for (const [key, limit, item] of [
    ['facts', 1000, { nodeId: 'n', property: 'p', value: '', unit: null }],
    ['checks', 200, { id: 'x', status: 'passed' }],
  ] as const) {
    cases.push({
      name: `snapshot-${key}-count`,
      schema: 'snapshot',
      accepted: {
        ...snapshot,
        [key]: Array.from({ length: limit }, () => item),
      },
      rejected: {
        ...snapshot,
        [key]: Array.from({ length: limit + 1 }, () => item),
      },
    });
  }
  const section = {
    topic: 'what',
    units: [{ kind: 'missing', text: 'This information is not recorded' }],
  };
  cases.push({
    name: 'section-count',
    schema: 'narrative',
    accepted: {
      ...narrative,
      sections: Array.from({ length: 20 }, () => section),
    },
    rejected: {
      ...narrative,
      sections: Array.from({ length: 21 }, () => section),
    },
  });
  const missing = { kind: 'missing', text: 'This information is not recorded' };
  cases.push({
    name: 'unit-count',
    schema: 'narrative',
    accepted: {
      ...narrative,
      sections: [
        { ...section, units: Array.from({ length: 50 }, () => missing) },
      ],
    },
    rejected: {
      ...narrative,
      sections: [
        { ...section, units: Array.from({ length: 51 }, () => missing) },
      ],
    },
  });
  const interpretation = {
    kind: 'interpretation',
    text: 'x',
    refs: [{ nodeId: 'n', property: 'p' }],
  };
  cases.push({
    name: 'interpretation-text',
    schema: 'narrative',
    accepted: {
      ...narrative,
      sections: [
        { ...section, units: [{ ...interpretation, text: 'x'.repeat(4096) }] },
      ],
    },
    rejected: {
      ...narrative,
      sections: [
        { ...section, units: [{ ...interpretation, text: 'x'.repeat(4097) }] },
      ],
    },
  });
  cases.push({
    name: 'reference-count',
    schema: 'narrative',
    accepted: {
      ...narrative,
      sections: [
        {
          ...section,
          units: [
            {
              ...interpretation,
              refs: Array.from({ length: 30 }, () => interpretation.refs[0]),
            },
          ],
        },
      ],
    },
    rejected: {
      ...narrative,
      sections: [
        {
          ...section,
          units: [
            {
              ...interpretation,
              refs: Array.from({ length: 31 }, () => interpretation.refs[0]),
            },
          ],
        },
      ],
    },
  });
  cases.push({
    name: 'message-text',
    schema: 'history',
    accepted: [{ message: 'x'.repeat(4096), narrative }],
    rejected: [{ message: 'x'.repeat(4097), narrative }],
  });
  cases.push({
    name: 'history-count',
    schema: 'history',
    accepted: Array.from({ length: 8 }, () => ({ message: 'x', narrative })),
    rejected: Array.from({ length: 9 }, () => ({ message: 'x', narrative })),
  });
  for (const key of ['title', 'disclaimer'] as const) {
    cases.push({
      name: `empty-${key}`,
      schema: 'snapshot',
      accepted: snapshot,
      rejected: { ...snapshot, [key]: '' },
    });
  }
  cases.push({
    name: 'empty-check-id',
    schema: 'snapshot',
    accepted: { ...snapshot, checks: [{ id: 'x', status: 'passed' }] },
    rejected: { ...snapshot, checks: [{ id: '', status: 'passed' }] },
  });
  cases.push({
    name: 'empty-units',
    schema: 'narrative',
    accepted: narrative,
    rejected: { ...narrative, sections: [{ topic: 'what', units: [] }] },
  });
  cases.push({
    name: 'empty-interpretation',
    schema: 'narrative',
    accepted: {
      ...narrative,
      sections: [{ ...section, units: [interpretation] }],
    },
    rejected: {
      ...narrative,
      sections: [{ ...section, units: [{ ...interpretation, text: '' }] }],
    },
  });
  return cases;
}
