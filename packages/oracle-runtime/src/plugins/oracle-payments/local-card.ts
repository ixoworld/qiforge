import { readFileSync } from 'node:fs';
import type { PluginManifest } from '../../plugin-api/types.js';
import { DisplayCardSchema, type AgentCardServiceView } from './types.js';

/** The local agent-card file, reduced to what manifest derivation consumes. */
export interface LocalAgentCard {
  /** `credentialSubject.id` — the oracle entity the card claims to describe. */
  subjectDid: string;
  name: string;
  description?: string;
  services: AgentCardServiceView[];
}

/**
 * Read and validate the agent-card JSON at `path`. The path is explicitly
 * configured, so every failure (missing file, bad JSON, wrong shape) throws
 * with a pointed message — a misconfigured card must fail boot, not silently
 * fall back to the static manifest.
 */
export function loadLocalAgentCard(path: string): LocalAgentCard {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `AGENT_CARD_PATH is set but the file cannot be read (${path}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`AGENT_CARD_PATH file is not valid JSON (${path})`);
  }

  const parsed = DisplayCardSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `AGENT_CARD_PATH file is not a valid agent card (${path}): ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }

  const subject = parsed.data.credentialSubject;
  return {
    subjectDid: subject.id,
    name: subject.name,
    description: subject.description,
    services: subject.services,
  };
}

function serviceLine(service: AgentCardServiceView): string {
  const currency = service.price.currency ?? 'USDC';
  const price =
    service.price.amount === 0 ? 'free' : `${service.price.amount} ${currency}`;
  const description = service.description ? `: ${service.description}` : '';
  return `User asks for "${service.name}" (${price})${description} — delivers ${service.deliverables}`;
}

/**
 * Derive the plugin manifest from the oracle's own card so the model knows its
 * services, prices, and deliverables without a tool call. The base manifest
 * stays the skeleton: derived entries are prepended/enriched, and the
 * `show_contract` example is retargeted at the card's first real service id so
 * the example never references a service this oracle doesn't offer.
 */
export function deriveManifestFromCard(
  base: PluginManifest,
  card: LocalAgentCard,
): PluginManifest {
  const services = card.services.map(
    (s) =>
      `${s.name} (${s.price.amount === 0 ? 'free' : `${s.price.amount} ${s.price.currency ?? 'USDC'}`})`,
  );
  const description = card.description ? ` ${card.description}` : '';
  const summary = `${card.name} —${description} Paid services: ${services.join(', ')}. ${base.summary}`;

  const firstServiceId = card.services[0]?.id;
  const examples = base.examples?.map((example) =>
    example.tool === 'show_contract' && firstServiceId
      ? { ...example, args: { serviceId: firstServiceId } }
      : example,
  );

  return {
    ...base,
    summary,
    whenToUse: [...base.whenToUse, ...card.services.map(serviceLine)],
    ...(examples !== undefined && { examples }),
  };
}
