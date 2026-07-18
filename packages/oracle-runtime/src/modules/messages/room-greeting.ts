export interface ComposeGreetingInput {
  oracleName: string;
  /** One-line oracle self-description from the identity config. */
  description?: string;
  /** DM (≤2 joined members) vs group room — group rooms get the engagement rule. */
  isDirect: boolean;
}

/**
 * Deterministic greeting the oracle posts when it is freshly added to a room.
 * Intentionally template-based (no LLM call): it must succeed for users who
 * have no authorization/credits yet, and the send itself doubles as the
 * Olm/Megolm bootstrap that makes the user's first encrypted message
 * decryptable.
 */
export function composeGreeting({
  oracleName,
  description,
  isDirect,
}: ComposeGreetingInput): string {
  const intro = description?.trim()
    ? `I'm ${oracleName} — ${description.trim().replace(/\.+$/, '')}.`
    : `I'm ${oracleName}.`;

  if (isDirect) {
    return [
      `👋 Hi! ${intro}`,
      `Ask me anything about what we do — FAQs included — or ask to speak with our human support team. For my full service, just ask how to authorize me.`,
    ].join('\n\n');
  }

  return [
    `👋 Hi everyone! ${intro}`,
    `Mention me (@${oracleName}) or reply to one of my messages when you need me — I stay quiet otherwise. I can answer questions about our domain or connect you with human support.`,
  ].join('\n\n');
}
