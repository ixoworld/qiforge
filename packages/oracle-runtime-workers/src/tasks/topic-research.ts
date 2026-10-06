import { z } from 'zod';
import { ArtifactRefSchema, type ArtifactRef } from '@ixo/common/work';
import { canonicalArguments } from '../core/middlewares/tool-execution';
import {
  markdownDigest,
  type TopicDeliverableSnapshot,
} from './topic-deliverables';

const text = z.string().trim().min(1).max(512);
const digest = z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/);
export const TopicResearchRequestSchema = z
  .object({
    topic: z
      .object({
        id: text,
        roomId: text,
        threadId: text,
        attemptId: text,
        observedRevision: text,
      })
      .strict(),
    title: z.string().trim().min(1).max(160),
    goal: z.string().trim().min(1).max(16000),
    instructions: z.string().max(16000),
    sources: z
      .array(z.object({ label: text, text: z.string().max(32000) }).strict())
      .max(20),
    skill: z.object({ id: text, version: text, digest }).strict(),
    capabilities: z.array(z.object({ with: text, can: text }).strict()).max(32),
    credentialNames: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/))
      .max(32),
  })
  .strict();
export type TopicResearchRequest = z.infer<typeof TopicResearchRequestSchema>;
export interface TopicResearchSnapshot extends Omit<
  TopicDeliverableSnapshot,
  'topic' | 'status'
> {
  requesterDid: string;
  topic: TopicResearchRequest['topic'];
  inputDigest: string;
  status: Exclude<TopicDeliverableSnapshot['status'], 'paused'>;
  artifacts: ArtifactRef[];
}
export type TopicResearchCommand =
  | { action: 'start' | 'cancel'; request: TopicResearchRequest }
  | { action: 'read' };
export type TopicResearchResult =
  | { ok: true; snapshot: TopicResearchSnapshot }
  | { ok: false; status: 404 | 409 | 429; message: string };
export const TOPIC_RESEARCH_BODY_BYTES = 1024 * 1024;
export function researchInputDigest(
  request: TopicResearchRequest,
): Promise<string> {
  return markdownDigest(
    canonicalArguments(TopicResearchRequestSchema.parse(request)),
  );
}
export function researchIntent(request: TopicResearchRequest): string {
  return (
    'Call run_topic_research once to obtain the authorized research evidence. Produce a Markdown report from its committed evidence and the frozen request. Distinguish evidence from inference; execution does not establish acceptance, determination or settlement.\n\n' +
    canonicalArguments(request)
  );
}
export const ResearchArtifactsSchema = z.array(ArtifactRefSchema).max(32);
