import type { Adapter } from '@ixo/agent-tools';
import {
  available,
  boundedText,
  digest,
  evidence,
  guarded,
  SourceFailure,
  type SourceHttp,
} from './http.js';

const TOPIC_URL = 'https://docs.ixo.world/articles/topics.md';
const TOPIC_DIGEST =
  'sha256:2eed6d29d09002930b46f4d473c362a9cf86daeb14f44ba7ed7bb9ec2ab2b77d';
export function conceptAdapter(http: SourceHttp): Adapter<'ixo_concept_get'> {
  return ({ context, input }) =>
    guarded(async () => {
      if (input.concept.trim().toLowerCase() !== 'topic')
        throw new SourceFailure('unavailable');
      const response = await http.fetcher(TOPIC_URL, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
        headers: { Accept: 'text/markdown' },
      });
      const text = await boundedText(response);
      if ((await digest(text)) !== TOPIC_DIGEST)
        throw new SourceFailure('unavailable');
      return available(context, { text }, [
        evidence(
          'canonical_document',
          TOPIC_URL,
          TOPIC_DIGEST,
          new Date().toISOString(),
        ),
      ]);
    });
}
