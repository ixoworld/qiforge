import type {
  SearchEnhancedResponse,
  UserContextData as TypedUserContextData,
} from '@ixo/common';
import { PromptTemplate } from '@langchain/core/prompts';
import type { OracleIdentity, UserContextData } from '../plugin-api/types.js';
import type { UserPreferences } from './state.js';

/**
 * Keys of UserContextData rendered into the prompt. Single source of truth for
 * both the section labels and the iteration order in buildContextBlock.
 */
type ContextSlot =
  | 'identity'
  | 'work'
  | 'goals'
  | 'interests'
  | 'relationships'
  | 'recent';

/**
 * Composer inputs. Each field maps 1:1 to a slot in the base template.
 * Plugins populate them via their middlewares (e.g. operationalMode comes
 * from a plugin that reads task-execution context); the runtime just stitches.
 */
export interface ComposePromptInput {
  identity: OracleIdentity;
  /** Pre-rendered Tier-1 capability block. Empty string when no eager plugins. */
  capabilityBlock: string;
  /**
   * Custom Instructions section body — author-supplied standing guidance
   * (`config.prompt.customInstructions`) plus any operating guides contributed
   * by on-demand capabilities the agent has loaded for this thread (e.g. the
   * Flow Builder guide). Empty string renders no section, so it costs nothing
   * on turns where nothing contributes.
   */
  customInstructions: string;
  /** Operational-mode block — typically a multi-line string. */
  operationalMode: string;
  /** Editor block — empty string when no editor session is active. */
  editorSection: string;
  /** Composio guidance block — empty when composio isn't loaded. */
  composioContext: string;
  /** Slack-specific formatting constraints. Empty string for non-slack clients. */
  slackFormattingConstraints: string;
  /** Matrix-specific formatting constraints. Empty string for non-matrix clients. */
  matrixFormattingConstraints: string;
  /** Per-key user-secret bullet list (e.g. `- _USER_SECRET_FOO`). Empty when none. */
  userSecretsContext: string;
  /** User preferences rendered as bullets. Empty when not set. */
  userPreferencesContext: string;
  /** Memory-engine context blocks. */
  userContext: UserContextData | undefined;
  /** Time context (timezone + current time). */
  timeContext: string;
  /** Currently-viewed entity DID, if any. */
  currentEntityDid: string;
  /** Optional override of the oracle name (e.g. user preference `agentName`). */
  oracleNameOverride?: string;
  /** Degraded-services notice appended after the main prompt body. */
  degradedServicesBlock?: string;
}

/**
 * The Slack constraints text. Identical to apps/app — kept here so the
 * runtime owns its own copy and the prompt composer is self-contained.
 */
export const SLACK_FORMATTING_CONSTRAINTS_CONTENT = `## Slack Formatting

Slack doesn't render markdown tables. When responding in a Slack session:
- Use bullet lists with bold labels ("• **Name:** value") instead of tables
- Use numbered lists for sequential data
- When delegating to sub-agents, ask them for list-based formatting (no tables)

`;

/**
 * Matrix chat constraints, injected when `session.client === 'matrix'`. Chat
 * replies stay chat-sized; deliberate long-form goes out as an artefact file
 * (the runtime also enforces this with an overflow guard on the reply path).
 */
export const MATRIX_FORMATTING_CONSTRAINTS_CONTENT = `## Matrix Chat Formatting

You are chatting in a Matrix room. Replies must read like chat, not documents:
- Be concise: short paragraphs, minimal headings, no wall-of-text enumerations. A reply should comfortably fit on one phone screen — stay well under 2,000 characters.
- When a complete answer genuinely needs long form, do NOT paste it into chat. Say in one sentence that you're attaching it, then deliver it as an artefact file:
  - \`share_artifact\` with format "md" for long-form TEXT (reports, guides, detailed answers). Not for code or raw JSON — keep those in chat code blocks unless the user asks for a file.
  - \`share_artifact\` with format "html" for VISUAL presentations (styled tables, comparisons, formatted summaries).
  - the editor's \`create_page\` for a COLLABORATIVE page/canvas people will edit together (when that tool is available).
- Oversized replies are auto-attached as a markdown file with a short lead-in — but attaching deliberately with \`share_artifact\` always reads better.

`;

/** Headers used for each populated memory-context sub-section. */
const CONTEXT_SECTION_LABELS: Record<ContextSlot, string> = {
  identity: 'Personal identity',
  work: 'Work & professional',
  goals: 'Goals & aspirations',
  interests: 'Interests & expertise',
  relationships: 'Relationships & social',
  recent: 'Recent activity',
};

// ── Memory-context rendering ────────────────────────────────────────────────
// Guardrail caps for the block. Cross-bucket dedup does the real shrinking;
// these only fire on pathological inputs so one entity/section can't dominate.
const COMPACT_ENTITY_SUMMARY_CAP = 700;
const COMPACT_BLOCK_BUDGET = 2000;
const COMPACT_OVERFLOW_NOTE = '_(More remembered — ask me to recall.)_';

/**
 * Normalize a line for duplicate detection: lowercase, strip surrounding
 * punctuation and collapse whitespace. Intentionally conservative — it only
 * collapses truly-identical content, so paraphrases ("asks to chart" vs "wants
 * to chart") survive as distinct facts and no unique information is dropped.
 */
function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,;:!?'"()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split a (possibly multi-line) summary into distinct lines not already seen
 * globally. Feeds the shared `seen` set so a summary line that duplicates a
 * standalone fact — or a line already shown for another entity — renders once.
 */
function dedupSummaryLines(text: string, seen: Set<string>): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const key = normalizeForDedup(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/** Truncate at a sentence/word boundary so a cap never cuts mid-word. */
function capAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const boundary = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('\n'),
    slice.lastIndexOf('; '),
    slice.lastIndexOf(' '),
  );
  const cut = boundary > max * 0.5 ? slice.slice(0, boundary) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * Render one memory-context bucket. Dedups entities (by name) and facts (by
 * normalized text) against a `seen` set shared across every bucket, using the
 * richest summary collected for each entity. Episodes and communities are kept
 * but deduped the same way — nothing is dropped by type, only by proven
 * redundancy.
 */
function formatContextSectionCompact(
  data: SearchEnhancedResponse | undefined,
  seen: Set<string>,
  richestSummary: Map<string, string>,
): string | null {
  if (!data) return null;
  const { entities, facts, episodes, communities } = data;
  const lines: string[] = [];

  if (entities?.length) {
    const entityLines: string[] = [];
    for (const e of entities) {
      const nameKey = `entity:${normalizeForDedup(e.name)}`;
      if (seen.has(nameKey)) continue;
      seen.add(nameKey);
      const labels = e.labels.filter((l) => l !== 'Entity').join('/');
      const tag = labels ? ` (${labels})` : '';
      const rawSummary = richestSummary.get(normalizeForDedup(e.name)) ?? '';
      const summaryParts = rawSummary
        ? dedupSummaryLines(rawSummary, seen)
        : [];
      const summary = summaryParts.length
        ? capAtBoundary(summaryParts.join('; '), COMPACT_ENTITY_SUMMARY_CAP)
        : '';
      entityLines.push(
        summary ? `- **${e.name}**${tag}: ${summary}` : `- **${e.name}**${tag}`,
      );
    }
    if (entityLines.length) lines.push('_Key entities:_', ...entityLines);
  }

  if (facts?.length) {
    const factLines: string[] = [];
    for (const f of facts) {
      const text = f.fact?.trim();
      if (!text) continue;
      const key = normalizeForDedup(text);
      if (seen.has(key)) continue;
      seen.add(key);
      factLines.push(`- ${text}`);
    }
    if (factLines.length) {
      if (lines.length) lines.push('');
      lines.push('_Facts:_', ...factLines);
    }
  }

  if (episodes?.length) {
    const epLines: string[] = [];
    for (const ep of episodes) {
      const content = ep.content?.trim();
      if (!content) continue;
      const key = normalizeForDedup(content);
      if (seen.has(key)) continue;
      seen.add(key);
      const date = ep.created_at?.slice(0, 10) ?? '';
      epLines.push(date ? `- *${date}* — ${content}` : `- ${content}`);
    }
    if (epLines.length) {
      if (lines.length) lines.push('');
      lines.push('_Episodes (raw):_', ...epLines);
    }
  }

  if (communities?.length) {
    const commLines: string[] = [];
    for (const c of communities) {
      const nameKey = `community:${normalizeForDedup(c.name)}`;
      if (seen.has(nameKey)) continue;
      seen.add(nameKey);
      const summary = c.summary?.trim();
      commLines.push(
        summary ? `- **${c.name}**: ${summary}` : `- **${c.name}**`,
      );
    }
    if (commLines.length) {
      if (lines.length) lines.push('');
      lines.push('_Topic clusters:_', ...commLines);
    }
  }

  return lines.length ? lines.join('\n') : null;
}

/**
 * Pre-scan every bucket for the richest (longest) summary per entity name, so
 * dedup keeps the most-informative copy rather than whichever bucket rendered
 * first.
 */
function collectRichestSummaries(
  typed: TypedUserContextData,
): Map<string, string> {
  const best = new Map<string, string>();
  for (const key of Object.keys(CONTEXT_SECTION_LABELS) as ContextSlot[]) {
    for (const e of typed[key]?.entities ?? []) {
      const nameKey = normalizeForDedup(e.name);
      const summary = e.summary?.trim() ?? '';
      const current = best.get(nameKey);
      if (current === undefined || summary.length > current.length) {
        best.set(nameKey, summary);
      }
    }
  }
  return best;
}

/**
 * Render the memory-context block — empty string when nothing is populated.
 *
 * The runtime always feeds in the strongly-typed UserContextData shape from
 * @ixo/common (see memory-engine.service.ts gatherUserContext), but the
 * plugin-api surface keeps it as `Record<string, unknown>` to avoid forcing
 * plugins to depend on the common package. Cast once at this boundary.
 *
 * Cross-bucket dedup + guardrail budgeting are always applied — the memory
 * engine returns six overlapping buckets, so an un-deduped block repeats the
 * same entities and facts several times over.
 */
function buildContextBlock(userContext: UserContextData | undefined): string {
  if (!userContext) return '';
  const typed = userContext as TypedUserContextData;

  const seen = new Set<string>();
  const richestSummary = collectRichestSummaries(typed);
  const sections: string[] = [];
  for (const key of Object.keys(CONTEXT_SECTION_LABELS) as ContextSlot[]) {
    const formatted = formatContextSectionCompact(
      typed[key],
      seen,
      richestSummary,
    );
    if (formatted) {
      sections.push(`**${CONTEXT_SECTION_LABELS[key]}**\n${formatted}`);
    }
  }
  const block = sections.join('\n\n');
  if (block.length <= COMPACT_BLOCK_BUDGET) return block;
  return `${capAtBoundary(block, COMPACT_BLOCK_BUDGET)}\n\n${COMPACT_OVERFLOW_NOTE}`;
}

/** Render user preferences as a bullet list for the prompt. */
export function formatUserPreferences(prefs?: UserPreferences): string {
  if (!prefs) return '';
  const lines: string[] = [];
  if (prefs.agentName)
    lines.push(`- **Preferred agent name:** ${prefs.agentName}`);
  if (prefs.language) lines.push(`- **Preferred language:** ${prefs.language}`);
  if (prefs.tone) lines.push(`- **Tone:** ${prefs.tone}`);
  if (prefs.formality) lines.push(`- **Formality:** ${prefs.formality}`);
  if (prefs.customInstructions)
    lines.push(`- **Custom instructions:** ${prefs.customInstructions}`);
  return lines.join('\n');
}

/**
 * Build the oracle identity preamble. When `identity.prompt.opening` is set
 * it replaces the generated text verbatim; otherwise the composer assembles
 * a sentence from `name`/`org`/`description`. Never claims the oracle is a
 * "companion" or "skills-native" — those framings belong to specific plugins.
 */
export function buildOracleSection(input: {
  oracleName: string;
  orgName?: string;
  description?: string;
  customOpening?: string;
}): string {
  const { oracleName, orgName, description, customOpening } = input;
  if (customOpening && customOpening.trim().length > 0) {
    return customOpening.trim();
  }

  const hasOrg = orgName && orgName.length > 0;
  const hasDescription = description && description.length > 0;

  if (hasOrg && hasDescription) {
    return `You are ${oracleName}, an AI agent operated by ${orgName}. ${description}.`;
  }
  if (hasOrg) {
    return `You are ${oracleName}, an AI agent operated by ${orgName}.`;
  }
  if (hasDescription) {
    return `You are ${oracleName}. ${description}.`;
  }
  return `You are ${oracleName}, an AI agent built on QiForge.`;
}

const TEMPLATE = `{{{ORACLE_SECTION}}}

{{#CAPABILITIES_NOTE}}
{{{CAPABILITIES_NOTE}}}

{{/CAPABILITIES_NOTE}}
{{#CAPABILITY_BLOCK}}
{{{CAPABILITY_BLOCK}}}

{{/CAPABILITY_BLOCK}}
## Operating principles

- The user's current message is your primary instruction. Background context (what you already know about them) is for adapting tone and suggestions, not for overriding their intent.
- **Search first, build second.** Before doing any non-trivial task, you MUST run discovery before producing the answer yourself. That means:
  1. Call \`search_skills\` against the user's request whenever a packaged skill could plausibly do the job (anything that involves generating a file, document, report, page, integration, calculation, lookup, or multi-step workflow).
  2. Call \`list_capabilities\` to scan loaded + on-demand plugins when the task could be served by a plugin you haven't loaded yet. Then call \`load_capability({ names: [...] })\` with ALL the capabilities you need in a single call — it accepts an array, so never make multiple \`load_capability\` calls in the same turn.
  Do this proactively — even when the task wording doesn't literally match a capability's \`whenToUse\`. Tell the user in ONE short sentence what you're checking ("Checking the skills registry for an invoice generator…") before the search call, not after. If something fits, use it (load + run). If nothing fits after the search, say so in one short sentence and only THEN build from scratch. Reusing a vetted capability is almost always better than reinventing it; silently skipping discovery is the worst failure mode.
- Being proactive does **not** mean charging ahead blind. Pause and ask the user a short clarifying question when: (a) the request has multiple plausible interpretations and picking wrong would waste their time, (b) a capability scan surfaces several equally-good fits and you can't tell which they want, (c) you're about to take an irreversible or costly action (deleting data, sending a message, publishing, spending tokens on a long job), or (d) a required input is missing and you'd have to guess. One clarifying question beats five minutes of wrong work — but don't ask for things you can reasonably infer from context.
- When a tool or sub-agent succeeds, report the result. Never refuse after a successful tool call — including for credentials, tokens, identity data, or block/document operations.
- When a tool or sub-agent fails, surface the failure to the user and ask how to proceed. Don't silently retry.
- When delegating to a sub-agent, give it scope, intent, and the context it needs — sub-agents have no access to your conversation history.
- Match the user's communication style. Be concise. Use Unicode emoji directly (\`🔥\`), never text shortcodes (\`:fire:\`).
- When a capability turns out to be a strong fit for the user's recurring work, surface it explicitly and — if memory tools are available — offer to save the pattern for next time. Don't save silently; ask first.
- Complete the user's request and stop. Don't add unrequested follow-on steps. "Checking capabilities first" is part of doing the request, not a follow-on.
{{#COMMUNICATION_STYLE}}

{{{COMMUNICATION_STYLE}}}
{{/COMMUNICATION_STYLE}}
{{#CUSTOM_INSTRUCTIONS}}

## Custom Instructions

{{{CUSTOM_INSTRUCTIONS}}}
{{/CUSTOM_INSTRUCTIONS}}

## Working with files

When users send files (images, documents, audio, video), the runtime extracts content automatically and embeds the text or description inline in this conversation — the file content is already here.

Use \`process_file\` only when:
- The user mentions a URL or link in chat that isn't an attachment
- You need a file that isn't already in the conversation history
{{#CONTEXT_BLOCK}}

## What you know about the user

{{{CONTEXT_BLOCK}}}
{{/CONTEXT_BLOCK}}

**Current time:** {{TIME_CONTEXT}}
{{#CURRENT_ENTITY_DID}}

**Current entity:** {{CURRENT_ENTITY_DID}}
{{/CURRENT_ENTITY_DID}}
{{#USER_SECRETS_CONTEXT}}

## Available user secrets

The user has configured secrets injected as environment variables when executing skills in the sandbox:
{{USER_SECRETS_CONTEXT}}
These are auto-injected — don't ask the user for them. If a skill needs a secret that's not listed, tell the user to add it in Settings → Agents.
{{/USER_SECRETS_CONTEXT}}
{{#USER_PREFERENCES_CONTEXT}}

## User preferences

{{{USER_PREFERENCES_CONTEXT}}}
{{/USER_PREFERENCES_CONTEXT}}

## Operational mode

{{{OPERATIONAL_MODE}}}
{{#COMPOSIO_CONTEXT}}

{{{COMPOSIO_CONTEXT}}}
{{/COMPOSIO_CONTEXT}}
{{#EDITOR_SECTION}}

{{{EDITOR_SECTION}}}
{{/EDITOR_SECTION}}
{{#SLACK_FORMATTING_CONSTRAINTS}}

{{{SLACK_FORMATTING_CONSTRAINTS}}}
{{/SLACK_FORMATTING_CONSTRAINTS}}
{{#MATRIX_FORMATTING_CONSTRAINTS}}

{{{MATRIX_FORMATTING_CONSTRAINTS}}}
{{/MATRIX_FORMATTING_CONSTRAINTS}}
`;

interface TemplateVariables {
  ORACLE_SECTION: string;
  CAPABILITIES_NOTE: string;
  CAPABILITY_BLOCK: string;
  CUSTOM_INSTRUCTIONS: string;
  COMMUNICATION_STYLE: string;
  CONTEXT_BLOCK: string;
  TIME_CONTEXT: string;
  CURRENT_ENTITY_DID: string;
  OPERATIONAL_MODE: string;
  EDITOR_SECTION: string;
  SLACK_FORMATTING_CONSTRAINTS: string;
  MATRIX_FORMATTING_CONSTRAINTS: string;
  USER_SECRETS_CONTEXT: string;
  COMPOSIO_CONTEXT: string;
  USER_PREFERENCES_CONTEXT: string;
}

const PROMPT_TEMPLATE = new PromptTemplate<TemplateVariables, never>({
  template: TEMPLATE,
  inputVariables: [
    'ORACLE_SECTION',
    'CAPABILITIES_NOTE',
    'CAPABILITY_BLOCK',
    'CUSTOM_INSTRUCTIONS',
    'COMMUNICATION_STYLE',
    'CONTEXT_BLOCK',
    'TIME_CONTEXT',
    'CURRENT_ENTITY_DID',
    'OPERATIONAL_MODE',
    'EDITOR_SECTION',
    'SLACK_FORMATTING_CONSTRAINTS',
    'MATRIX_FORMATTING_CONSTRAINTS',
    'USER_SECRETS_CONTEXT',
    'COMPOSIO_CONTEXT',
    'USER_PREFERENCES_CONTEXT',
  ],
  templateFormat: 'mustache',
});

/**
 * Compose the runtime's system prompt. Slots split into:
 *   - **identity** — from `OracleConfig` (custom opening or generated).
 *   - **capabilities** — author note (config.prompt.capabilities) + Tier-1 block.
 *   - **operating principles** — fixed + optional `communicationStyle` from config.
 *   - **working with files** — runtime-universal (FileProcessingService).
 *   - **context** — only populated memory sub-sections render; empty ones skipped.
 *   - **operational mode / composio / editor / slack** — existing plugin hooks.
 */
export async function composePrompt(
  input: ComposePromptInput,
): Promise<string> {
  const oracleName = input.oracleNameOverride ?? input.identity.name;
  const oracleSection = buildOracleSection({
    oracleName,
    orgName: input.identity.org,
    description: input.identity.description,
    customOpening: input.identity.prompt?.opening,
  });

  const capabilitiesNote = input.identity.prompt?.capabilities?.trim() ?? '';
  const communicationStyle =
    input.identity.prompt?.communicationStyle?.trim() ?? '';

  const rendered = await PROMPT_TEMPLATE.format({
    ORACLE_SECTION: oracleSection,
    CAPABILITIES_NOTE: capabilitiesNote,
    CAPABILITY_BLOCK: input.capabilityBlock,
    CUSTOM_INSTRUCTIONS: input.customInstructions,
    COMMUNICATION_STYLE: communicationStyle,
    CONTEXT_BLOCK: buildContextBlock(input.userContext),
    TIME_CONTEXT: input.timeContext,
    CURRENT_ENTITY_DID: input.currentEntityDid,
    OPERATIONAL_MODE: input.operationalMode,
    EDITOR_SECTION: input.editorSection,
    SLACK_FORMATTING_CONSTRAINTS: input.slackFormattingConstraints,
    MATRIX_FORMATTING_CONSTRAINTS: input.matrixFormattingConstraints,
    USER_SECRETS_CONTEXT: input.userSecretsContext,
    COMPOSIO_CONTEXT: input.composioContext,
    USER_PREFERENCES_CONTEXT: input.userPreferencesContext,
  });

  if (input.degradedServicesBlock && input.degradedServicesBlock.length > 0) {
    return `${rendered}\n\n---\n\n## Degraded services\n\n${input.degradedServicesBlock}\n`;
  }
  return rendered;
}

/**
 * Format a (timezone, currentTime) pair into a stable prompt block. Public so
 * forks driving their own `composePrompt` calls can re-use it.
 */
export function formatTimeContext(
  timezone: string | undefined,
  currentTime: string | undefined,
): string {
  if (!timezone && !currentTime) return 'Not available.';
  const parts: string[] = [];
  if (currentTime) parts.push(currentTime);
  if (timezone) parts.push(`(${timezone})`);
  return parts.join(' ') || 'Not available.';
}
