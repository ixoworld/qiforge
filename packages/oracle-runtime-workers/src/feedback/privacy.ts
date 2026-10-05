/**
 * The two privacy primitives of anonymous feedback: screening the text for
 * direct identifiers and secrets before it goes anywhere, and keyed
 * pseudonyms for the user, session and message so issues can be grouped
 * without revealing who wrote them or about which conversation.
 */

/** Direct identifiers and credentials a feedback text must not carry. */
const DIRECT_IDENTIFIER_PATTERNS: ReadonlyArray<{
  kind: string;
  pattern: RegExp;
}> = [
  {
    kind: 'email address',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  },
  { kind: 'Matrix identifier', pattern: /@[A-Z0-9._=-]+:[A-Z0-9.-]+/i },
  {
    kind: 'decentralized identifier',
    pattern: /\bdid:[a-z0-9]+:[A-Za-z0-9._:%-]+\b/i,
  },
  {
    kind: 'wallet address',
    pattern: /\b(?:ixo|cosmos)1[0-9a-z]{20,}\b|\b0x[a-fA-F0-9]{40}\b/,
  },
  {
    kind: 'credential',
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_ -]?key|password|secret|token|authorization)\s*[:=]\s*\S+/i,
  },
  {
    kind: 'secret-bearing URL',
    pattern:
      /https?:\/\/\S+[?&](?:access_token|api_key|apikey|auth|key|password|secret|token)=/i,
  },
];

/**
 * A run of digits and phone separators, opening at the start or after a
 * space or `(`, closing before the end, a space or punctuation. A run can
 * hold more than one number (a date, then a phone number), so every window
 * of its whitespace-separated pieces is checked on its own.
 */
const DIGIT_RUN = /(?:^|[\s(])([+(]?\d[\d\s().-]*\d\)?)(?=$|[\s.,;:)!?])/gu;
const ISO_DATE = /^\(?\d{4}-\d{2}-\d{2}\)?$/;
/** A grouped amount such as `1 000 000` or `1,250,000`. */
const GROUPED_AMOUNT = /^\d{1,3}(?:[ .,]\d{3})+$/;
/** E.164 allows 15 digits; national numbers have at least 9 with the trunk prefix. */
const PHONE_DIGITS = { min: 9, max: 15 };

function looksLikePhone(candidate: string): boolean {
  if (!/^[+(]?\d/.test(candidate) || !/\d\)?$/.test(candidate)) return false;
  const digits = candidate.replace(/\D/g, '').length;
  return (
    digits >= PHONE_DIGITS.min &&
    digits <= PHONE_DIGITS.max &&
    !GROUPED_AMOUNT.test(candidate)
  );
}

function containsPhoneNumber(text: string): boolean {
  for (const run of text.matchAll(DIGIT_RUN)) {
    const pieces = run[1]!.split(/\s+/);
    for (let start = 0; start < pieces.length; start += 1)
      for (let end = start; end < pieces.length; end += 1) {
        // A date is never part of a phone number; wider windows keep it.
        if (ISO_DATE.test(pieces[end]!)) break;
        if (looksLikePhone(pieces.slice(start, end + 1).join(' '))) return true;
      }
  }
  return false;
}

/**
 * What is screened is what is sent: compatibility forms folded (a fullwidth
 * `＠` is `@`) and invisible format characters (zero-width spaces and joiners,
 * bidi marks) removed, so neither can split an identifier past the patterns.
 */
function normalizeFeedbackText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .trim();
}

export type FeedbackScreening =
  | { ok: true; text: string }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'personal_data'; kind: string };

/**
 * Normalise and trim the text, and reject it when it is empty or carries a direct
 * identifier or a secret. The caller answers a rejection without saying
 * which part matched, and never logs the text.
 */
export function screenFeedbackText(raw: string): FeedbackScreening {
  const text = normalizeFeedbackText(raw);
  if (!text) return { ok: false, reason: 'empty' };
  const match = DIRECT_IDENTIFIER_PATTERNS.find(({ pattern }) =>
    pattern.test(text),
  );
  if (match) return { ok: false, reason: 'personal_data', kind: match.kind };
  if (containsPhoneNumber(text))
    return { ok: false, reason: 'personal_data', kind: 'phone number' };
  return { ok: true, text };
}

export type FingerprintNamespace = 'user' | 'session' | 'message' | 'ip';

/**
 * `<namespace>_<hex HMAC-SHA256>` over the namespace and the parts. Stable
 * for one secret, unlinkable across namespaces, and not reversible without
 * the secret — the same derivation the Node runtime used.
 */
export async function feedbackFingerprint(
  secret: string,
  namespace: FingerprintNamespace,
  ...parts: string[]
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode([namespace, ...parts].join('\0')),
  );
  const hex = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  return `${namespace}_${hex}`;
}
