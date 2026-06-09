import { Injectable } from '@nestjs/common';
import type { AmbientServices } from '../../../../runtime-context/ambient.js';

export type IntentLabel = 'approved' | 'rejected' | 'other';

const APPROVE_KEYWORDS = new Set([
  'yes',
  'y',
  'yeah',
  'yep',
  'ok',
  'okay',
  'sure',
  'approve',
  'approved',
  'do it',
  'go',
  'ship',
  'send',
  'confirm',
  'confirmed',
]);

const REJECT_KEYWORDS = new Set([
  'no',
  'n',
  'nope',
  'cancel',
  'reject',
  'rejected',
  'stop',
  "don't",
  'dont',
  'abort',
  'kill',
]);

/**
 * Fast keyword path → tiny-LLM fallback. ~95% of replies hit the fast path.
 */
@Injectable()
export class IntentClassifier {
  async classify(text: string, ambient: AmbientServices): Promise<IntentLabel> {
    const fast = this.fastPath(text);
    if (fast !== 'other') return fast;
    return this.slowPath(text, ambient);
  }

  fastPath(text: string): IntentLabel {
    // Strip trailing punctuation, lowercase, collapse whitespace.
    const normalized = text
      .trim()
      .toLowerCase()
      .replace(/[.!?,;:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return 'other';
    if (APPROVE_KEYWORDS.has(normalized)) return 'approved';
    if (REJECT_KEYWORDS.has(normalized)) return 'rejected';
    // Short replies: take the first 1–2 tokens.
    if (normalized.length <= 32) {
      const tokens = normalized.split(' ');
      const head1 = tokens[0] ?? '';
      const head2 = tokens.slice(0, 2).join(' ');
      if (APPROVE_KEYWORDS.has(head1) || APPROVE_KEYWORDS.has(head2))
        return 'approved';
      if (REJECT_KEYWORDS.has(head1) || REJECT_KEYWORDS.has(head2))
        return 'rejected';
    }
    return 'other';
  }

  private async slowPath(
    text: string,
    ambient: AmbientServices,
  ): Promise<IntentLabel> {
    try {
      const model = ambient.llm.get('utility');
      const prompt = [
        'Classify this user reply as one of: approved, rejected, other.',
        'Return ONLY the single word — no punctuation, no explanation.',
        'A pending action is awaiting their confirmation.',
        '',
        `Reply: "${text.slice(0, 280)}"`,
        '',
        'Label:',
      ].join('\n');
      const res = await model.invoke(prompt);
      const raw = typeof res.content === 'string' ? res.content : '';
      const norm = raw.trim().toLowerCase().split(/\s+/)[0] ?? '';
      if (norm === 'approved' || norm === 'approve') return 'approved';
      if (norm === 'rejected' || norm === 'reject') return 'rejected';
      return 'other';
    } catch {
      // If the slow path fails for any reason, fall through to 'other'
      // so the user's message reaches the normal agent path.
      return 'other';
    }
  }
}
