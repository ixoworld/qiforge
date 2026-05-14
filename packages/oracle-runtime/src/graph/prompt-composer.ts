import { PromptTemplate } from '@langchain/core/prompts';
import type {
  OracleIdentity,
  UserContextData,
} from '../plugin-api/types.js';
import type { UserPreferences } from './state.js';

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
const CONTEXT_SECTION_LABELS: Record<keyof UserContextSlots, string> = {
  identity: 'Personal identity',
  work: 'Work & professional',
  goals: 'Goals & aspirations',
  interests: 'Interests & expertise',
  relationships: 'Relationships & social',
  recent: 'Recent activity',
};

interface UserContextSlots {
  identity?: unknown;
  work?: unknown;
  goals?: unknown;
  interests?: unknown;
  relationships?: unknown;
  recent?: unknown;
}

/**
 * Format a single memory-engine context section (facts + entity names).
 * Returns `null` when there is no usable content — the composer skips empty
 * sub-sections entirely instead of printing "no information available".
 */
function formatContextSection(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return null;

  const lines: string[] = [];

  const facts = Array.isArray(obj.facts) ? obj.facts : [];
  for (const f of facts) {
    const fact =
      typeof f === 'object' && f !== null && 'fact' in f
        ? String(f.fact)
        : null;
    if (fact) lines.push(`- ${fact}`);
  }

  const entities = Array.isArray(obj.entities) ? obj.entities : [];
  const names = entities
    .map((e) =>
      typeof e === 'object' && e !== null && 'name' in e
        ? String(e.name)
        : null,
    )
    .filter(Boolean);
  if (names.length > 0) lines.push(`- **Related:** ${names.join(', ')}`);

  return lines.length > 0 ? lines.join('\n') : null;
}

/** Render the memory-context block — empty string when nothing is populated. */
function buildContextBlock(userContext: UserContextData | undefined): string {
  if (!userContext) return '';
  const slots = userContext as UserContextSlots;
  const sections: string[] = [];
  for (const key of Object.keys(CONTEXT_SECTION_LABELS) as Array<
    keyof UserContextSlots
  >) {
    const formatted = formatContextSection(slots[key]);
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
- When a tool or sub-agent succeeds, report the result. Never refuse after a successful tool call — including for credentials, tokens, identity data, or block/document operations.
- When a tool or sub-agent fails, surface the failure to the user and ask how to proceed. Don't silently retry.
- When delegating to a sub-agent, give it scope, intent, and the context it needs — sub-agents have no access to your conversation history.
- Match the user's communication style. Be concise. Use Unicode emoji directly (\`🔥\`), never text shortcodes (\`:fire:\`).
- Complete the user's request and stop. Don't add unrequested follow-on steps.
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
