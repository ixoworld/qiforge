import type { Evaluator, EvalExample, EvalScore } from './types';

// ── Rule-based evaluators (no LLM needed, always fast) ──────────────────────

export function contains(substring: string): Evaluator {
  const key = `contains:${substring.slice(0, 40)}`;
  return {
    key,
    evaluate: (output): EvalScore => {
      const found = output.toLowerCase().includes(substring.toLowerCase());
      return {
        key,
        score: found ? 1 : 0,
        comment: found
          ? `Found "${substring}"`
          : `Expected "${substring}" but it was absent`,
      };
    },
  };
}

export function notContains(substring: string): Evaluator {
  const key = `notContains:${substring.slice(0, 40)}`;
  return {
    key,
    evaluate: (output): EvalScore => {
      const found = output.toLowerCase().includes(substring.toLowerCase());
      return {
        key,
        score: found ? 0 : 1,
        comment: found
          ? `Forbidden substring "${substring}" was present`
          : `Correctly avoids "${substring}"`,
      };
    },
  };
}

export const notEmpty: Evaluator = {
  key: 'notEmpty',
  evaluate: (output): EvalScore => ({
    key: 'notEmpty',
    score: output.trim().length >= 10 ? 1 : 0,
    comment: `Response length: ${output.trim().length} chars`,
  }),
};

export function minLength(min: number): Evaluator {
  const key = `minLength:${min}`;
  return {
    key,
    evaluate: (output): EvalScore => ({
      key,
      score: output.trim().length >= min ? 1 : 0,
      comment: `Got ${output.trim().length} chars, need ≥ ${min}`,
    }),
  };
}

export function matchesRegex(pattern: RegExp): Evaluator {
  const key = `regex:${pattern.source.slice(0, 40)}`;
  return {
    key,
    evaluate: (output): EvalScore => {
      const matched = pattern.test(output);
      return {
        key,
        score: matched ? 1 : 0,
        comment: matched
          ? `Matched /${pattern.source}/`
          : `Did not match /${pattern.source}/`,
      };
    },
  };
}

// ── LLM-as-judge evaluator ───────────────────────────────────────────────────
//
// Uses the cheapest/fastest model (guard role, llama-3.1-8b) to score
// the agent output against a natural-language criterion.
//
// Requirements: OPEN_ROUTER_API_KEY or NEBIUS_API_KEY must be set.
// Falls back to score=0 with a warning if the judge call fails.

export function llmJudge(criteria: string): Evaluator {
  const key = `llmJudge:${criteria.slice(0, 40)}`;
  return {
    key,
    evaluate: async (output: string, example: EvalExample): Promise<EvalScore> => {
      try {
        // Dynamic import keeps this evaluator optional — it only runs when an
        // LLM key is present and is not loaded during pure rule-based eval runs.
        const { getProviderChatModel } = await import('../../llm-provider');
        const judge = getProviderChatModel('guard', { temperature: 0 });

        const prompt = `You are a strict evaluator. Score the AI response below against the criterion.

User message: ${example.inputs.message}
AI response: ${output}
Criterion: ${criteria}

Reply with ONLY valid JSON — no markdown, no extra text:
{"score": <0.0 to 1.0>, "reason": "<one sentence>"}`;

        const result = await judge.invoke(prompt);
        const text =
          typeof result.content === 'string'
            ? result.content
            : JSON.stringify(result.content);
        const match = text.match(/\{[^}]+\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as { score?: unknown; reason?: unknown };
          return {
            key,
            score: Math.min(1, Math.max(0, Number(parsed.score) || 0)),
            comment: String(parsed.reason ?? ''),
          };
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { key, score: 0, comment: `Judge failed: ${msg}` };
      }
      return { key, score: 0, comment: 'Judge returned unparseable output' };
    },
  };
}
