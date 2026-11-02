/**
 * Upstream text (entity profiles, form titles and questions, programme
 * descriptions) is written by whoever made the entity or form: it is
 * clipped before the model sees it and the tools say it is data, never
 * instructions.
 */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A trimmed, clipped string, or undefined for anything else or an empty one. */
export function clippedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? clip(trimmed, max) : undefined;
}
