import MiniSearch from 'minisearch';
import type { PluginManifest } from '../plugin-api/types.js';

/** A plugin manifest paired with the name of the plugin that contributed it. */
export interface SearchEntry {
  pluginName: string;
  manifest: PluginManifest;
}

/** A ranked search hit returned by `SearchIndex.query`. */
export interface SearchResult {
  name: string;
  score: number;
  summary: string;
  /** Comma-separated query terms that contributed to the score. */
  matchReason: string;
}

/** Manifest search index over discoverable plugins. */
export interface SearchIndex {
  query: (q: string, limit?: number) => SearchResult[];
}

interface IndexedDoc {
  id: string;
  whenToUse: string;
  tags: string;
  summary: string;
}

/**
 * Build a manifest search index over the discoverable plugins.
 *
 * Silent plugins are excluded — they are invisible to the agent. Field
 * weights bias matches toward intent triggers (`whenToUse`) and tags over
 * the summary, since those are the deliberately curated discovery surfaces.
 */
export function buildSearchIndex(entries: SearchEntry[]): SearchIndex {
  const candidates = entries.filter(
    ({ manifest }) => manifest.visibility !== 'silent',
  );

  const summaries = new Map<string, string>();
  const docs: IndexedDoc[] = candidates.map(({ pluginName, manifest }) => {
    summaries.set(pluginName, manifest.summary);
    return {
      id: pluginName,
      whenToUse: manifest.whenToUse.join(' '),
      tags: (manifest.tags ?? []).join(' '),
      summary: manifest.summary,
    };
  });

  const index = new MiniSearch<IndexedDoc>({
    fields: ['whenToUse', 'tags', 'summary'],
    storeFields: ['id'],
    searchOptions: {
      boost: { whenToUse: 2, tags: 1.5, summary: 1 },
      prefix: true,
      fuzzy: 0.2,
      combineWith: 'OR',
    },
  });
  index.addAll(docs);

  return {
    query(q, limit = 5) {
      if (!q.trim() || docs.length === 0) return [];
      return index
        .search(q)
        .slice(0, limit)
        .map((hit) => ({
          name: hit.id as string,
          score: hit.score,
          summary: summaries.get(hit.id as string) ?? '',
          matchReason: `matched: ${hit.terms.join(', ')}`,
        }));
    },
  };
}
