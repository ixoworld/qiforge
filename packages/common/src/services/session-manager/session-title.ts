import { Logger } from '@ixo/logger';
import {
  getChatOpenAiModel,
  getLLMProvider,
  getOpenRouterChatModel,
  getProviderConfig,
} from '../../ai/models/openai.js';

/**
 * A conversation turn used as title-generation input. Roles matter: the title
 * must describe what the *user* came for, so the model needs to know who said
 * what instead of reading an unlabelled blob of text.
 */
export interface SessionTitleMessage {
  type: 'ai' | 'human';
  content: string;
}

/**
 * Accepted title input. The `string[]` form is the legacy shape kept for
 * published consumers of `@ixo/common` — roles are unknown there, so the
 * transcript is rendered without speaker labels.
 */
export type SessionTitleInput = string | SessionTitleMessage;

interface NormalizedMessage {
  role: 'human' | 'ai' | 'unknown';
  content: string;
}

/** Placeholder held until a conversation has enough substance to name. */
export const UNTITLED_SESSION = 'Untitled';

/** Titles are chips in a sidebar — anything longer is a sentence, not a name. */
const MAX_TITLE_CHARS = 60;
const MAX_TITLE_WORDS = 8;
/** The deterministic fallback clips a user sentence, so it stays tighter. */
const MAX_FALLBACK_WORDS = 6;
const MIN_TITLE_CHARS = 3;
/** A title is decided from the opening of the conversation, not the whole log. */
const MAX_INPUT_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 600;
/** At/above this length a verbatim match against the transcript is an echo. */
const ECHO_WORD_THRESHOLD = 5;

/** Openers a chat model uses when it answers *about* the task instead of doing it. */
const PREAMBLE_RE =
  /^(sure|certainly|of course|okay|ok|here(?:'s| is)|the title|based on)\b/i;

/**
 * Model used to name conversations. Deliberately a small, cheap,
 * instruction-following model — this runs once per session, off the request
 * path. Override per deployment with `SESSION_TITLE_MODEL`.
 */
export function getSessionTitleModel(): string {
  const override = process.env.SESSION_TITLE_MODEL?.trim();
  if (override) return override;
  return getLLMProvider() === 'nebius'
    ? 'Qwen/Qwen3-30B-A3B-Instruct-2507'
    : 'google/gemini-3.1-flash-lite';
}

function normalize(messages: SessionTitleInput[]): NormalizedMessage[] {
  return messages
    .map<NormalizedMessage>((message) =>
      typeof message === 'string'
        ? { role: 'unknown', content: message }
        : { role: message.type, content: message.content },
    )
    .map((message) => ({ ...message, content: message.content.trim() }))
    .filter((message) => message.content.length > 0);
}

/**
 * A title is only worth generating once the conversation has a topic: one real
 * user turn and one real assistant turn. Tool-only assistant turns arrive with
 * empty content and are already dropped by `normalize`, so a session that has
 * only fired tools stays `Untitled` instead of being named after nothing.
 */
export function hasEnoughContextForTitle(
  messages: SessionTitleInput[],
): boolean {
  const normalized = normalize(messages);
  if (normalized.some((m) => m.role === 'unknown'))
    return normalized.length >= 2;
  return (
    normalized.some((m) => m.role === 'human') &&
    normalized.some((m) => m.role === 'ai')
  );
}

/** `true` when the stored title is still a placeholder and may be replaced. */
export function needsTitle(title: string | undefined | null): boolean {
  if (!title) return true;
  const trimmed = title.trim();
  return trimmed.length === 0 || trimmed.toLowerCase() === 'untitled';
}

function renderTranscript(messages: NormalizedMessage[]): string {
  return messages
    .slice(0, MAX_INPUT_MESSAGES)
    .map((message) => {
      const body =
        message.content.length > MAX_MESSAGE_CHARS
          ? `${message.content.slice(0, MAX_MESSAGE_CHARS)}…`
          : message.content;
      if (message.role === 'unknown') return body;
      return `${message.role === 'human' ? 'User' : 'Assistant'}: ${body}`;
    })
    .join('\n');
}

export function buildTitlePrompt(messages: SessionTitleInput[]): string {
  return `You name chat conversations. Read the transcript and reply with a short title naming its topic.

Rules:
- 2 to 6 words. A name, never a sentence.
- Title Case. No quotes, no markdown, no trailing punctuation.
- Name the subject the user needs help with — not the assistant, not the format of the reply.
- Summarise. Never copy a phrase verbatim from the transcript.
- If the transcript has no real topic, reply exactly: General Chat
- Reply with the title and nothing else.

Transcript:
User: Can you help me reset my password?
Assistant: Sure — I can walk you through it.
Title: Password Reset Help

Transcript:
User: what are the store opening hours?
Assistant: We are open 9am to 5pm, Monday to Friday.
Title: Store Opening Hours

Transcript:
User: did u see the new dashboard i shipped?
Assistant: I did, though the filters feel cramped on mobile.
Title: New Dashboard Feedback

Transcript:
${renderTranscript(normalize(messages))}
Title:`;
}

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function capToWidth(title: string): string {
  if (title.length <= MAX_TITLE_CHARS) return title;
  const cut = title.slice(0, MAX_TITLE_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > MIN_TITLE_CHARS ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Turn raw model output into a storable title, or `null` when the output is
 * not a title at all. Rejecting is the point: a rejected title falls back to a
 * deterministic one, whereas truncating a rambling answer produces exactly the
 * kind of clipped mid-sentence title this guards against.
 */
export function sanitizeTitle(
  raw: string,
  sources: SessionTitleInput[] = [],
): string | null {
  const withoutThinking = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<\/?think>/gi, ' ');

  const line = withoutThinking
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (!line) return null;

  const title = line
    .replace(/^#+\s*/, '')
    .replace(/^(?:conversation\s+)?title\s*[:\-–—]\s*/i, '')
    .replace(/^[\s"'“”‘’`*_]+/, '')
    .replace(/[\s"'“”‘’`*_]+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]+$/, '')
    .trim();

  if (title.length < MIN_TITLE_CHARS) return null;
  if (PREAMBLE_RE.test(title)) return null;

  const words = title.split(' ');
  if (words.length > MAX_TITLE_WORDS) return null;

  // An "echo" is the model handing back a slice of the conversation instead of
  // a name for it. Short titles are allowed to coincide with the wording of the
  // transcript ("Store Opening Hours"); long verbatim matches are copies.
  if (words.length >= ECHO_WORD_THRESHOLD) {
    const needle = normalizeForComparison(title);
    const echoed = normalize(sources).some((message) =>
      normalizeForComparison(message.content).includes(needle),
    );
    if (echoed) return null;
  }

  return capToWidth(title);
}

/**
 * Deterministic title used when the model output is unusable. Derived from the
 * user's opening request, so it is always about what the user asked for.
 */
export function fallbackTitle(messages: SessionTitleInput[]): string | null {
  const normalized = normalize(messages);
  const first =
    normalized.find((message) => message.role === 'human') ??
    normalized.find((message) => message.role === 'unknown');
  if (!first) return null;

  const flattened = first.content.replace(/\s+/g, ' ').trim();
  const sentence = flattened.split(/(?<=[.!?])\s/)[0] ?? flattened;
  const words = sentence.split(' ');
  const wasClipped = words.length > MAX_FALLBACK_WORDS;

  let title = capToWidth(words.slice(0, MAX_FALLBACK_WORDS).join(' '));
  // A clip lands mid-thought; falling back to the last clause boundary turns
  // "my visit ran over, what should I" into "my visit ran over".
  if (wasClipped) {
    const lastClause = title.lastIndexOf(',');
    if (lastClause >= MIN_TITLE_CHARS) title = title.slice(0, lastClause);
  }
  title = title.replace(/[.,;:!?]+$/, '').trim();
  if (title.length < MIN_TITLE_CHARS) return null;

  return title.charAt(0).toUpperCase() + title.slice(1);
}

function createTitleModel() {
  const model = getSessionTitleModel();
  const config = getProviderConfig();

  return getLLMProvider() === 'openrouter'
    ? getOpenRouterChatModel({
        model,
        temperature: 0.3,
        maxTokens: 64,
        timeout: 60_000,
      })
    : getChatOpenAiModel({
        model,
        temperature: 0.3,
        maxTokens: 64,
        timeout: 60_000,
        apiKey: config.apiKey,
        configuration: { baseURL: config.baseURL },
      });
}

/**
 * Name a conversation. Returns `null` when the conversation is too thin to
 * name — callers keep the `Untitled` placeholder and try again on a later turn.
 * Never throws: a failed title must not fail the session sync around it.
 */
export async function generateSessionTitle(
  messages: SessionTitleInput[],
): Promise<string | null> {
  if (!hasEnoughContextForTitle(messages)) return null;

  try {
    const response = await createTitleModel().invoke(
      buildTitlePrompt(messages),
    );
    const title = sanitizeTitle(String(response.content), messages);
    if (title) return title;
    Logger.warn(
      'Session title model returned an unusable title; using the fallback',
    );
  } catch (error) {
    Logger.error('Failed to generate a session title:', error);
  }

  return fallbackTitle(messages);
}
