/**
 * What a model step may not deliver to a chat user, whatever model wrote it:
 * its reasoning and raw tool output.
 *
 * On 13 Nov 2026 a fallback model (Qwen3 235B Thinking, served by Venice)
 * split its stream wrongly: the reasoning field stopped mid-thought and the
 * rest of the thinking came as the message content, quoting the turn's tool
 * result verbatim (`{"ok":false,"status":"awaiting_user",…}`) before the
 * reply it meant to send. The plan delivers every step's text, so the person
 * got all of it. Two rules close this for every model:
 *
 * - **Reasoning tags.** Text inside `<think>`, `<thinking>` or `<reasoning>`
 *   is reasoning, and so is everything before a closing tag whose opener is
 *   missing (a template that puts the opener in the prompt) or after an
 *   opener that never closes (a reply cut off mid-thought). It is removed.
 * - **Raw tool output.** A step whose text holds a JSON tool result of the
 *   thread verbatim is not delivered: a model writing to a person never
 *   pastes the tool's JSON, a model thinking aloud does. Only results that
 *   are JSON (an object or an array, at least {@link MIN_ECHO_CHARS}
 *   characters) count, so a tool's plain sentence repeated as the answer is
 *   kept.
 *
 * Reasoning with neither tags nor a tool result in it cannot be told from a
 * reply by its text; the provider's own reasoning field carries it, and the
 * plan never reads that field.
 */

const REASONING_TAGS = ['think', 'thinking', 'reasoning'] as const;

/** Shortest JSON tool result the echo check looks for. */
export const MIN_ECHO_CHARS = 24;

/** `text` without its reasoning-tag parts (see the module comment). */
export function withoutReasoningTags(text: string): string {
  let out = text;
  for (const tag of REASONING_TAGS) {
    const open = new RegExp(`<${tag}>`, 'i');
    const close = new RegExp(`</${tag}>`, 'i');
    if (!open.test(out) && !close.test(out)) continue;
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'gi'), '');
    const closers = [...out.matchAll(new RegExp(`</${tag}>`, 'gi'))];
    const lastClose = closers.at(-1);
    if (lastClose?.index !== undefined)
      out = out.slice(lastClose.index + lastClose[0].length);
    const opener = open.exec(out);
    if (opener) out = out.slice(0, opener.index);
  }
  return out === text ? text : out.trim();
}

/** The thread's tool results that are JSON, as the echo check reads them. */
export function jsonToolOutputs(contents: Iterable<string>): string[] {
  const outputs = new Set<string>();
  for (const content of contents) {
    const trimmed = content.trim();
    if (trimmed.length < MIN_ECHO_CHARS) continue;
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (!((first === '{' && last === '}') || (first === '[' && last === ']')))
      continue;
    outputs.add(trimmed);
  }
  return [...outputs];
}

/** Whether `text` holds one of `outputs` verbatim. */
export function echoesToolOutput(
  text: string,
  outputs: readonly string[],
): boolean {
  if (text.length < MIN_ECHO_CHARS) return false;
  return outputs.some((output) => text.includes(output));
}
