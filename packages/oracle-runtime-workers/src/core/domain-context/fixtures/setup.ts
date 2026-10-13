/** Test helpers: fixture domains served by an in-memory transport. */
import { vi } from 'vitest';
import { record } from '../document';
import { cidOf } from '../integrity';
import type { DocumentRequest, DomainAnchor, DomainTransport } from '../types';
import { domainFixture } from './domain';

export const FIXTURE_DID = 'did:ixo:entity:fixture';

/** The fixture re-issued for another DID (every identity field follows). */
export function domainFor(did: string, text = domainFixture): string {
  return text.split(FIXTURE_DID).join(did);
}

/** The fixture with its JSON frontmatter changed by `mutate`. */
export function withFrontmatter(
  mutate: (front: Record<string, unknown>) => void,
  text = domainFixture,
): string {
  const [, json, ...body] = text.split(/^---$/m);
  if (json === undefined) throw new Error('fixture has no frontmatter');
  const front: Record<string, unknown> = JSON.parse(json);
  mutate(front);
  return `---\n${JSON.stringify(front, null, 2)}\n---${body.join('---')}`;
}

/**
 * `did`'s fixture (two entries) with `count` malformed document entries
 * appended: the validator reports 18 findings per entry. Its lint time grows
 * about quadratically with the entry count (about 9 s for 1 000 entries,
 * 76 s for 3 000), which is why the resolver refuses any frontmatter list of
 * more than 64 items before linting.
 */
export function hostileIndex(did: string, count = 1000): string {
  return withFrontmatter((front) => {
    const index = record(front.documents);
    const list: unknown[] = Array.isArray(index.entries) ? index.entries : [];
    for (let i = 0; i < count; i++) list.push({ id: `bad-${i}` });
    front.documents = { ...index, entries: list };
  }, domainFor(did));
}

export interface LinkedDocument {
  id: string;
  uri: string;
  cid: string;
  text: string;
}

export async function linkedDocument(
  id: string,
  text: string,
): Promise<LinkedDocument> {
  const bytes = new TextEncoder().encode(text);
  return {
    id,
    uri: `https://docs.example/${id}`,
    cid: await cidOf(bytes),
    text,
  };
}

/**
 * The fixture whose pass-1 documents are exactly `documents` (extension
 * entries, all public, readable and without a freshness bound). The two
 * universal entries the schema requires stay, moved to disclosure pass 2.
 */
export function withPass1(
  documents: LinkedDocument[],
  text = domainFixture,
): string {
  return withFrontmatter((front) => {
    const index = front.documents;
    if (!index || typeof index !== 'object' || !('entries' in index))
      throw new Error('fixture has no document index');
    const universal: unknown[] = Array.isArray(index.entries)
      ? index.entries
      : [];
    const template = {
      category: 'extension',
      manifest_type: null,
      name: 'Linked document',
      media_type: 'text/markdown',
      version: '1.0.0',
      owner: 'did:ixo:entity:dataset-curator',
      update_authority: ['did:ixo:entity:dataset-curator'],
      authority: 'interpretive',
      disclosure_pass: 1,
      required_for_tasks: ['onboarding'],
      sensitivity: 'public',
      access_policy: 'public',
      agent_use: { read: true, cite: true, summarize: false },
      freshness: { last_verified: null, max_age: null },
      supersedes: null,
    };
    Object.assign(index, {
      entries: [
        ...universal.map((entry) => ({ ...record(entry), disclosure_pass: 2 })),
        ...documents.map((document) => ({
          ...template,
          role: `x-${document.id}`,
          id: document.id,
          uri: document.uri,
          cid: document.cid,
        })),
      ],
    });
  }, text);
}

/** An in-memory transport over `files` (by URI) with one anchor per DID. */
export async function servedDomains(
  domains: Record<string, string>,
  linked: LinkedDocument[] = [],
) {
  const files = new Map<string, Uint8Array>();
  const anchors = new Map<string, DomainAnchor | null>();
  for (const [did, text] of Object.entries(domains)) {
    const bytes = new TextEncoder().encode(text);
    const uri = `https://docs.example/${encodeURIComponent(did)}/domain.md`;
    files.set(uri, bytes);
    anchors.set(did, {
      did,
      cid: await cidOf(bytes),
      uri,
      private: false,
      resolvedAt: 0,
      source: 'https://iid.example',
    });
  }
  for (const document of linked)
    files.set(document.uri, new TextEncoder().encode(document.text));
  const transport = {
    resolve: vi.fn(
      async (did: string): Promise<DomainAnchor | null> =>
        anchors.get(did) ?? null,
    ),
    read: vi.fn(async (request: DocumentRequest): Promise<Uint8Array> => {
      const bytes = files.get(request.uri);
      if (!bytes) throw new Error('document-unavailable');
      return bytes;
    }),
  } satisfies DomainTransport;
  return { transport, files, anchors };
}

/** The anchor `servedDomains` publishes for `did`. */
export function anchorOf(
  anchors: Map<string, DomainAnchor | null>,
  did: string,
): DomainAnchor {
  const anchor = anchors.get(did);
  if (!anchor) throw new Error(`no anchor for ${did}`);
  return anchor;
}
