import { isAIMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { createByoChatModel } from '../llm/byo-client';
import type { ByoTurnState } from '../llm/byo-service';
import {
  canonical,
  narrativeSchema,
  sha256,
  validateNarrative,
  type Snapshot,
  type ExecutionReceipt,
  type SkillReceipt,
  type HistoryTurn,
} from './contracts';
import { reportingSkillSource } from './skill-source';

export async function reportingSkill() {
  return {
    id: 'reporter-grounded',
    version: '1.0.0',
    contentHash: await sha256(reportingSkillSource),
  };
}
export class ReportingOutputError extends Error {
  constructor(
    readonly skill: SkillReceipt,
    readonly execution: ExecutionReceipt,
  ) {
    super('Provider output failed source validation');
  }
}
export async function executeReportingSkill(
  snapshot: Snapshot,
  message: string,
  turn: ByoTurnState,
  history: HistoryTurn[],
  signal?: AbortSignal,
) {
  const model = createByoChatModel({
    credential: turn.credential,
    modelId: turn.mainModelId,
    role: 'main',
    chatGptBackend: turn.chatGptBackend,
    params: { maxRetries: 0, timeout: 45_000 },
  });
  const input = { snapshot, message, history };
  const result = await model
    .withStructuredOutput(narrativeSchema, {
      name: 'reporter_narrative',
      method: 'jsonSchema',
      includeRaw: true,
    })
    .invoke(
      [
        { role: 'system', content: reportingSkillSource },
        { role: 'user', content: canonical(input) },
      ],
      { signal, callbacks: [], tags: ['reporter-grounded'] },
    );
  if (!isAIMessage(result.raw))
    throw new Error('Provider response is not an AI message');
  const metadata = z
    .object({ model_name: z.string().optional(), model: z.string().optional() })
    .parse(result.raw.response_metadata);
  const actualModel = metadata.model_name ?? metadata.model;
  const usage = result.raw.usage_metadata;
  if (
    typeof actualModel !== 'string' ||
    !actualModel ||
    !usage ||
    !Number.isSafeInteger(usage.input_tokens) ||
    !Number.isSafeInteger(usage.output_tokens)
  )
    throw new Error('Provider execution receipt unavailable');
  const execution: ExecutionReceipt = {
    requestedModel: turn.byoModelId,
    actualModel,
    provider: turn.provider,
    funding: 'byo_only',
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    settlement: 'not_applicable',
  };
  const skill: SkillReceipt = {
    ...(await reportingSkill()),
    inputDigest: await sha256(canonical(input)),
    outputDigest: await sha256(canonical(result.parsed ?? result.raw.content)),
  };
  try {
    const narrative = validateNarrative(result.parsed, snapshot);
    return { narrative, skill, execution };
  } catch {
    throw new ReportingOutputError(skill, execution);
  }
}
