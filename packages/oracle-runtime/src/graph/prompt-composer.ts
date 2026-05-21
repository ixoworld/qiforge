import type {
  SearchEnhancedResponse,
  UserContextData as TypedUserContextData,
} from '@ixo/common';
import { PromptTemplate } from '@langchain/core/prompts';
import type {
  OracleIdentity,
  UserContextData,
} from '../plugin-api/types.js';
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
  /** Operational-mode block — typically a multi-line string. */
  operationalMode: string;
  /** Editor block — empty string when no editor session is active. */
  editorSection: string;
  /** Composio guidance block — empty when composio isn't loaded. */
  composioContext: string;
  /** Slack-specific formatting constraints. Empty string for non-slack clients. */
  slackFormattingConstraints: string;
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

/** Headers used for each populated memory-context sub-section. */
const CONTEXT_SECTION_LABELS: Record<ContextSlot, string> = {
  identity: 'Personal identity',
  work: 'Work & professional',
  goals: 'Goals & aspirations',
  interests: 'Interests & expertise',
  relationships: 'Relationships & social',
  recent: 'Recent activity',
};

/**
 * Format a single memory-engine context section as mid-density rich content.
 *
 * Goal: enough high-level signal that the agent can converse without re-querying,
 * but compact enough that six categorical sections don't blow up the prompt.
 * The agent can always deep-dive via the search_memory_engine tool.
 *
 * Layout per section (in priority order):
 *   1. **Key entities** with summaries — entity.summary contains the richest
 *      multi-fact synthesis graphiti produces (e.g. "user had a 1:1 with Carlos
 *      at 2pm today; user agreed to do the database migration in three phases").
 *   2. **Facts** — short relationship-level bullets for breadth.
 *   3. **Recent episodes** — raw source text, only when `includeEpisodes` is on.
 *
 * Returns `null` when the slot has no usable content — composer drops the
 * sub-section entirely rather than emitting an empty header.
 */
/**
 * Render a single SearchEnhancedResponse slot. Dumps everything the memory
 * engine returned — entities (with their multi-fact summaries), facts,
 * episodes (raw source text), and communities (topic clusters). The server
 * already caps result counts via per-query max_* settings, so no further
 * truncation is needed here.
 *
 * Returns `null` for an empty/missing slot so the composer can skip the
 * sub-section entirely instead of printing a bare header.
 */
function formatContextSection(
  data: SearchEnhancedResponse | undefined,
): string | null {
  if (!data) return null;
  const { entities, facts, episodes, communities } = data;
  if (
    !entities?.length &&
    !facts?.length &&
    !episodes?.length &&
    !communities?.length
  ) {
    return null;
  }

  const lines: string[] = [];

  if (entities?.length) {
    lines.push('_Key entities:_');
    for (const e of entities) {
      const labels = e.labels.filter((l) => l !== 'Entity').join('/');
      const tag = labels ? ` (${labels})` : '';
      const summary = e.summary?.trim();
      lines.push(
        summary ? `- **${e.name}**${tag}: ${summary}` : `- **${e.name}**${tag}`,
      );
    }
  }

  if (facts?.length) {
    if (lines.length) lines.push('');
    lines.push('_Facts:_');
    for (const f of facts) {
      const text = f.fact?.trim();
      if (text) lines.push(`- ${text}`);
    }
  }

  if (episodes?.length) {
    if (lines.length) lines.push('');
    lines.push('_Episodes (raw):_');
    for (const ep of episodes) {
      const content = ep.content?.trim();
      if (!content) continue;
      const date = ep.created_at?.slice(0, 10) ?? '';
      lines.push(date ? `- *${date}* — ${content}` : `- ${content}`);
    }
  }

  if (communities?.length) {
    if (lines.length) lines.push('');
    lines.push('_Topic clusters:_');
    for (const c of communities) {
      const summary = c.summary?.trim();
      lines.push(
        summary ? `- **${c.name}**: ${summary}` : `- **${c.name}**`,
      );
    }
  }

  return lines.length ? lines.join('\n') : null;
}

/**
 * Render the memory-context block — empty string when nothing is populated.
 *
 * The runtime always feeds in the strongly-typed UserContextData shape from
 * @ixo/common (see memory-engine.service.ts gatherUserContext), but the
 * plugin-api surface keeps it as `Record<string, unknown>` to avoid forcing
 * plugins to depend on the common package. Cast once at this boundary.
 */
function buildContextBlock(userContext: UserContextData | undefined): string {
  if (!userContext) return '';
  const typed = userContext as TypedUserContextData;
  const sections: string[] = [];
  for (const key of Object.keys(CONTEXT_SECTION_LABELS) as ContextSlot[]) {
    const formatted = formatContextSection(typed[key]);
    if (formatted) {
      sections.push(`**${CONTEXT_SECTION_LABELS[key]}**\n${formatted}`);
    }
  }
  return sections.join('\n\n');
}

/** Render user preferences as a bullet list for the prompt. */
export function formatUserPreferences(prefs?: UserPreferences): string {
  if (!prefs) return '';
  const lines: string[] = [];
  if (prefs.agentName)
    lines.push(`- **Preferred agent name:** ${prefs.agentName}`);
  if (prefs.language)
    lines.push(`- **Preferred language:** ${prefs.language}`);
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
- Before doing a non-trivial task from scratch, scan **Available Capabilities** above for a possible fit and try a relevant discovery/search tool (e.g. \`list_*\` / \`search_*\`) — even when the task wording doesn't literally match a capability's \`whenToUse\`. Reusing an existing capability is almost always better than reinventing it. When uncertain whether something exists, call \`list_capabilities\` before generating from scratch.
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
`;

interface TemplateVariables {
  ORACLE_SECTION: string;
  CAPABILITIES_NOTE: string;
  CAPABILITY_BLOCK: string;
  COMMUNICATION_STYLE: string;
  CONTEXT_BLOCK: string;
  TIME_CONTEXT: string;
  CURRENT_ENTITY_DID: string;
  OPERATIONAL_MODE: string;
  EDITOR_SECTION: string;
  SLACK_FORMATTING_CONSTRAINTS: string;
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
    'COMMUNICATION_STYLE',
    'CONTEXT_BLOCK',
    'TIME_CONTEXT',
    'CURRENT_ENTITY_DID',
    'OPERATIONAL_MODE',
    'EDITOR_SECTION',
    'SLACK_FORMATTING_CONSTRAINTS',
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
export async function composePrompt(input: ComposePromptInput): Promise<string> {
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
    COMMUNICATION_STYLE: communicationStyle,
    CONTEXT_BLOCK: buildContextBlock(input.userContext),
    TIME_CONTEXT: input.timeContext,
    CURRENT_ENTITY_DID: input.currentEntityDid,
    OPERATIONAL_MODE: input.operationalMode,
    EDITOR_SECTION: input.editorSection,
    SLACK_FORMATTING_CONSTRAINTS: input.slackFormattingConstraints,
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
