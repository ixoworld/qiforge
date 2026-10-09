/**
 * Resolves and verifies one domain: IID anchor → bytes → CID check → strict
 * UTF-8 → `domain.md` lint → identity and profile checks → optional capsule
 * manifest inspection. One instance lives per user Durable Object and is
 * shared by every session of that user, so its caches are what make a repeat
 * turn cheap:
 *
 * - anchors per DID (TTL, at most 32), with in-flight deduplication so
 *   concurrent sessions share one Blocksync lookup;
 * - verified public bytes per CID (LRU, 8 MiB);
 * - decoded public text per CID (LRU, 4 Mi characters);
 * - parsed indexes per anchor CID (lint report, brief JSON, capsule
 *   inspections; LRU, 16 entries and 4 Mi characters of index text), so a
 *   repeat turn re-parses nothing.
 *
 * Private bytes are not kept in the content caches: every private read goes
 * back through the transport, which re-authorizes it. The parsed index of a
 * private document (its text included) does stay in the parsed-index cache,
 * keyed by CID, but it is only handed out again after a fresh authorized read
 * of bytes that verify against that CID.
 *
 * Every finding list is bounded where it enters a snapshot (see
 * `findings.ts`).
 */
import type { DomainDocument } from '@ixo/domain.md/workers';
import { z } from 'zod';
import { estimateTokensApprox } from '../manifest';
import { briefBody, record } from './document';
import { boundFindings } from './findings';
import { decode, INDEX_MAX_BYTES, verifyBytes } from './integrity';
import { LruMap } from './lru';
import type {
  DocumentRequest,
  DomainAnchor,
  DomainCapsuleInspection,
  DomainSnapshot,
  DomainTransport,
} from './types';
import { domainValidator } from './validator';

export const DEFAULT_ANCHOR_TTL_MS = 300_000;
/** A shared anchor lookup owns this timeout; one cancelled subscriber never cancels it. */
export const ANCHOR_LOOKUP_TIMEOUT_MS = 10_000;
/** `source` of an anchor taken from a durable run's pins. */
export const PINNED_ANCHOR_SOURCE = 'durable-run-pin';

const MAX_ANCHORS = 32;
const CONTENT_CACHE_BYTES = 8 * 1024 * 1024;
/** No single cached document may take more than a quarter of the content cache. */
const MAX_CACHED_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_ENTRIES = 256;
const TEXT_CACHE_CHARS = 4 * 1024 * 1024;
const MAX_PARSED_INDEXES = 16;
/** Index text the parsed-index cache holds in all (a parsed index keeps its raw text). */
export const PARSED_CACHE_CHARS = 4 * 1024 * 1024;
/** No single parsed index may take more than a quarter of that. */
const MAX_CACHED_PARSE_CHARS = PARSED_CACHE_CHARS / 4;
const MAX_CAPSULES_PER_INDEX = 4;
/** Most items any frontmatter list (at any depth) may hold before the index is refused unlinted. */
export const MAX_FRONTMATTER_ARRAY_ITEMS = 64;
/** Deepest nesting of objects and lists the frontmatter may have (the frontmatter mapping is depth 1). */
export const MAX_FRONTMATTER_DEPTH = 16;
/** Largest YAML frontmatter (UTF-8 bytes) linted. */
export const MAX_FRONTMATTER_BYTES = 64 * 1024;

/**
 * True when `value` has a list of more than {@link MAX_FRONTMATTER_ARRAY_ITEMS}
 * items, or nests deeper than {@link MAX_FRONTMATTER_DEPTH}, anywhere. The
 * walk stops at the first violation and never descends past the depth bound.
 */
export function exceedsFrontmatterShape(value: unknown, depth = 1): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (depth > MAX_FRONTMATTER_DEPTH) return true;
  const children: unknown[] = Array.isArray(value)
    ? value
    : Object.values(value);
  if (Array.isArray(value) && value.length > MAX_FRONTMATTER_ARRAY_ITEMS)
    return true;
  return children.some((child) => exceedsFrontmatterShape(child, depth + 1));
}
/** The frontmatter fence, as `@ixo/domain.md` matches it. */
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
/**
 * `externalChecksRequired` codes the resolver performs itself, so they are
 * not reported as unresolved: the index bytes are verified against the
 * anchored CID before they are parsed, and every linked document is verified
 * against its declared CID before it is used.
 */
const CHECKS_PERFORMED = new Set(['cid-verification']);

const CAPSULE_CONTRACT = 'ixo.earth/oracle-capsule/v0alpha1';
const DID_PATTERN = /^did:ixo:[^\s#/?]+(?::[^\s#/?]+)*$/;
const FINDING_PATTERN = /^[a-z][a-z0-9-]{1,70}$/;
const INVALID_PATTERN = /mismatch|invalid|unsupported|unanchored|utf8/;

/** A capsule result plus the findings it adds to its snapshot. */
interface CapsuleResult {
  capsule: DomainCapsuleInspection;
  findings: string[];
}

/** Everything derived from one index's bytes, keyed by its CID. */
interface ParsedIndex {
  /** Set when the bytes cannot be decoded at all. */
  error?: string;
  ok: boolean;
  findings: string[];
  unresolvedChecks: string[];
  document?: DomainDocument;
  brief?: { json: string; tokens: number };
  /** Keyed by `<did>\n<manifest cid>`; only deterministic outcomes are kept. */
  capsules: LruMap<string, CapsuleResult>;
}

const capsuleBinding = z.object({
  uri: z.string(),
  cid: z.string(),
  sha256: z.string(),
  version: z.string(),
  schema: z.string(),
  media_type: z.literal('application/vnd.ixo.oracle-capsule+json'),
});

/**
 * What a parsed index weighs in the parsed-index cache: the characters of the
 * index text it keeps. An invalid parse keeps no document, so it weighs
 * nothing beyond its (bounded) finding codes.
 */
function parsedWeight(entry: ParsedIndex): number {
  return entry.document?.raw.length ?? 0;
}

/** The stable code of an error, or `fallback` when its message is not one. */
export function errorCode(error: unknown, fallback: string): string {
  return error instanceof Error && FINDING_PATTERN.test(error.message)
    ? error.message
    : fallback;
}

function waitFor<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('domain-context-cancelled'),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(
          error instanceof Error
            ? error
            : new Error('domain-context-resolution-failed'),
        );
      },
    );
  });
}

export class DomainContextResolver {
  private readonly now: () => number;
  private readonly anchors = new LruMap<
    string,
    { anchor: DomainAnchor | null; checked: number }
  >({ maxEntries: MAX_ANCHORS });
  private readonly pending = new Map<string, Promise<DomainAnchor | null>>();
  private readonly content = new LruMap<string, Uint8Array>({
    maxEntries: MAX_CONTENT_ENTRIES,
    maxWeight: CONTENT_CACHE_BYTES,
    weigh: (bytes) => bytes.length,
  });
  private readonly text = new LruMap<string, string>({
    maxEntries: MAX_CONTENT_ENTRIES,
    maxWeight: TEXT_CACHE_CHARS,
    weigh: (text) => text.length,
  });
  private readonly parsed = new LruMap<string, ParsedIndex>({
    maxEntries: MAX_PARSED_INDEXES,
    maxWeight: PARSED_CACHE_CHARS,
    weigh: parsedWeight,
  });

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Forget the cached anchor of `did` so the next load asks Blocksync again.
   * A lookup already in flight still answers its current subscribers but can
   * no longer repopulate the cache; the last verified anchor stays available
   * as a labelled stale fallback.
   */
  invalidate(did: string): void {
    const old = this.anchors.get(did);
    if (old) this.anchors.set(did, { ...old, checked: -Infinity });
    this.pending.delete(did);
  }

  async load(
    did: string,
    transport: DomainTransport,
    opts: {
      ttlMs?: number;
      signal?: AbortSignal;
      pinned?: { cid: string; uri: string; private: boolean };
    } = {},
  ): Promise<DomainSnapshot> {
    const snapshot = await this.loadSnapshot(did, transport, opts);
    snapshot.findings = boundFindings(snapshot.findings);
    return snapshot;
  }

  private async loadSnapshot(
    did: string,
    transport: DomainTransport,
    opts: {
      ttlMs?: number;
      signal?: AbortSignal;
      pinned?: { cid: string; uri: string; private: boolean };
    },
  ): Promise<DomainSnapshot> {
    const { signal, pinned } = opts;
    const prefix: string[] = [];
    if (pinned) {
      const anchor: DomainAnchor = {
        did,
        ...pinned,
        resolvedAt: this.now(),
        source: PINNED_ANCHOR_SOURCE,
      };
      try {
        signal?.throwIfAborted();
        if (!DID_PATTERN.test(did)) throw new Error('invalid-anchor-did');
        const bytes = await this.bytes(
          { ...anchor, maxBytes: INDEX_MAX_BYTES },
          transport,
          signal,
        );
        return await this.fromBytes(
          { did, status: 'unavailable', stale: false, anchor, findings: [] },
          bytes,
          transport,
          signal,
        );
      } catch (error) {
        signal?.throwIfAborted();
        if (errorCode(error, '') === 'invalid-anchor-did')
          return {
            did,
            status: 'invalid',
            stale: false,
            findings: ['invalid-anchor-did'],
          };
        prefix.push('pinned-revision-unavailable');
      }
    }
    const snapshot = await this.resolveAndLoad(
      did,
      transport,
      opts.ttlMs ?? DEFAULT_ANCHOR_TTL_MS,
      signal,
    );
    snapshot.findings.unshift(...prefix);
    return snapshot;
  }

  /**
   * Bytes for `request`, verified against its CID. Public bytes come from the
   * content cache when present; private ones (or a transport that reports the
   * request as authenticated) are read every time.
   */
  async bytes(
    request: DocumentRequest,
    transport: DomainTransport,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const cacheable = this.cacheable(request, transport);
    const cached = cacheable ? this.content.get(request.cid) : undefined;
    if (cached) {
      if (cached.length > request.maxBytes)
        throw new Error('document-too-large');
      return cached;
    }
    const bytes = await transport.read(request, signal);
    if (bytes.length > request.maxBytes) throw new Error('document-too-large');
    await verifyBytes(bytes, request.cid);
    if (cacheable && bytes.length <= MAX_CACHED_DOCUMENT_BYTES)
      this.content.set(request.cid, bytes);
    return bytes;
  }

  /** {@link bytes} decoded as strict UTF-8; public text is cached by CID. */
  async readText(
    request: DocumentRequest,
    transport: DomainTransport,
    signal?: AbortSignal,
  ): Promise<string> {
    const cacheable = this.cacheable(request, transport);
    const cached = cacheable ? this.text.get(request.cid) : undefined;
    if (cached !== undefined) return cached;
    const text = decode(await this.bytes(request, transport, signal));
    if (cacheable) this.text.set(request.cid, text);
    return text;
  }

  /**
   * The serialized brief of a verified snapshot and its token estimate,
   * computed once per index CID.
   */
  brief(
    snapshot: DomainSnapshot,
  ): { json: string; tokens: number } | undefined {
    if (!snapshot.document) return undefined;
    const entry = snapshot.anchor
      ? this.parsed.get(snapshot.anchor.cid)
      : undefined;
    if (entry?.brief && entry.document === snapshot.document)
      return entry.brief;
    const json = JSON.stringify(briefBody(snapshot.document));
    const brief = { json, tokens: estimateTokensApprox(json) };
    if (entry && entry.document === snapshot.document) entry.brief = brief;
    return brief;
  }

  private cacheable(
    request: DocumentRequest,
    transport: DomainTransport,
  ): boolean {
    return !request.private && (transport.isPublic?.(request) ?? true);
  }

  private async resolveAndLoad(
    did: string,
    transport: DomainTransport,
    ttl: number,
    signal?: AbortSignal,
  ): Promise<DomainSnapshot> {
    const snapshot: DomainSnapshot = {
      did,
      status: 'unavailable',
      stale: false,
      findings: [],
    };
    try {
      signal?.throwIfAborted();
      if (!DID_PATTERN.test(did)) throw new Error('invalid-anchor-did');
      const resolved = await waitFor(this.anchor(did, transport, ttl), signal);
      signal?.throwIfAborted();
      if (!resolved.value)
        return { ...snapshot, status: 'missing', findings: ['anchor-missing'] };
      snapshot.anchor = resolved.value;
      snapshot.stale = resolved.stale;
      const bytes = await this.bytes(
        { ...resolved.value, maxBytes: INDEX_MAX_BYTES },
        transport,
        signal,
      );
      return await this.fromBytes(snapshot, bytes, transport, signal);
    } catch (error) {
      signal?.throwIfAborted();
      return this.failed(snapshot, error);
    }
  }

  private failed(snapshot: DomainSnapshot, error: unknown): DomainSnapshot {
    const code = errorCode(error, 'resolution-failed');
    const failed: DomainSnapshot = {
      ...snapshot,
      status: INVALID_PATTERN.test(code) ? 'invalid' : 'unavailable',
      findings: [...snapshot.findings, code],
    };
    delete failed.document;
    return failed;
  }

  /** Verified `snapshot.anchor` bytes → a verified (or invalid) snapshot. */
  private async fromBytes(
    snapshot: DomainSnapshot,
    bytes: Uint8Array,
    transport: DomainTransport,
    signal?: AbortSignal,
  ): Promise<DomainSnapshot> {
    const did = snapshot.did;
    const anchor = snapshot.anchor;
    if (!anchor) throw new Error('anchor-missing');
    try {
      const parsed = await this.parse(anchor.cid, bytes);
      if (parsed.error) throw new Error(parsed.error);
      snapshot.findings = [...parsed.findings];
      if (!parsed.ok || !parsed.document) {
        snapshot.status = 'invalid';
        return snapshot;
      }
      const front = parsed.document.frontmatter;
      if (
        record(front.domain).id !== did ||
        record(front.domain).iid !== did ||
        record(front.source_of_truth).iid_document !== did ||
        record(front.constitution).subject !== did
      )
        throw new Error('domain-identity-mismatch');
      if (
        !['anchored', 'runtime'].includes(
          String(record(front.conformance).profile),
        )
      )
        throw new Error('unanchored-profile');
      snapshot.status = 'verified';
      snapshot.document = parsed.document;
      snapshot.findings.push(...parsed.unresolvedChecks);
      if (snapshot.stale) snapshot.findings.push('anchor-stale');
      const binding = record(front['x-oracle-capsule']);
      if (Object.keys(binding).length) {
        const result = await this.inspectCapsule(
          parsed,
          snapshot,
          binding,
          transport,
          signal,
        );
        snapshot.capsule = result.capsule;
        snapshot.findings.push(...result.findings);
      }
      return snapshot;
    } catch (error) {
      signal?.throwIfAborted();
      return this.failed(snapshot, error);
    }
  }

  /**
   * Decode + lint, once per CID while the entry stays cached. The bytes have
   * already been verified against `cid`. Finding codes are deduplicated and
   * bounded here, so a cached entry never holds the validator's full report.
   */
  private async parse(cid: string, bytes: Uint8Array): Promise<ParsedIndex> {
    const cached = this.parsed.get(cid);
    if (cached) return cached;
    const entry: ParsedIndex = {
      ok: false,
      findings: [],
      unresolvedChecks: [],
      capsules: new LruMap({ maxEntries: MAX_CAPSULES_PER_INDEX }),
    };
    let text: string | undefined;
    try {
      text = decode(bytes);
    } catch (error) {
      entry.error = errorCode(error, 'invalid-utf8');
    }
    if (text !== undefined && (await this.tooLarge(text))) {
      entry.findings = ['index-too-large'];
    } else if (text !== undefined) {
      const report = await domainValidator.lint(text, {
        sourceName: 'domain.md',
        maxBytes: INDEX_MAX_BYTES,
      });
      entry.ok = report.ok;
      entry.findings = boundFindings(
        report.findings.map((finding) => finding.code),
      );
      entry.unresolvedChecks = boundFindings(
        report.externalChecksRequired
          .filter((check) => !CHECKS_PERFORMED.has(check.code))
          .map((check) => `unresolved:${check.code}`),
      );
      // Only a valid parse keeps the document (and with it the raw text).
      if (report.ok && report.document) entry.document = report.document;
    }
    if (parsedWeight(entry) <= MAX_CACHED_PARSE_CHARS)
      this.parsed.set(cid, entry);
    return entry;
  }

  /**
   * True when the index is too large to lint. The validator's lint time grows
   * about quadratically with the number of findings (seconds for a few
   * hundred malformed list items, in any list), so the frontmatter's size is
   * checked first by the fence's regular expression, then its shape (list
   * lengths, nesting depth) on the library's parse, whose cost is linear.
   */
  private async tooLarge(text: string): Promise<boolean> {
    const frontmatter = FRONTMATTER.exec(text)?.[1];
    if (
      frontmatter !== undefined &&
      new TextEncoder().encode(frontmatter).length > MAX_FRONTMATTER_BYTES
    )
      return true;
    const parsed = await domainValidator.parseDomain(text, {
      sourceName: 'domain.md',
      maxBytes: INDEX_MAX_BYTES,
    });
    return exceedsFrontmatterShape(parsed.document?.frontmatter);
  }

  private async anchor(
    did: string,
    transport: DomainTransport,
    ttl: number,
  ): Promise<{ value: DomainAnchor | null; stale: boolean }> {
    const old = this.anchors.get(did);
    if (old && this.now() - old.checked < ttl)
      return { value: old.anchor, stale: false };
    let pending = this.pending.get(did);
    if (!pending) {
      const lookup: Promise<DomainAnchor | null> = transport
        .resolve(did, AbortSignal.timeout(ANCHOR_LOOKUP_TIMEOUT_MS))
        .then((anchor) => {
          if (this.pending.get(did) === lookup)
            this.anchors.set(did, { anchor, checked: this.now() });
          return anchor;
        })
        .catch((error: unknown) => {
          // A malformed anchor is a confirmed state, not an outage: drop the
          // fallback so no later turn reuses a revision the IID disowned.
          if (
            this.pending.get(did) === lookup &&
            errorCode(error, '').startsWith('invalid-anchor')
          )
            this.anchors.delete(did);
          throw error;
        })
        .finally(() => {
          if (this.pending.get(did) === lookup) this.pending.delete(did);
        });
      this.pending.set(did, lookup);
      pending = lookup;
    }
    try {
      return { value: await pending, stale: false };
    } catch (error) {
      if (errorCode(error, '').startsWith('invalid-anchor')) throw error;
      if (old?.anchor) return { value: old.anchor, stale: true };
      throw error;
    }
  }

  private async inspectCapsule(
    parsed: ParsedIndex,
    snapshot: DomainSnapshot,
    binding: Record<string, unknown>,
    transport: DomainTransport,
    signal?: AbortSignal,
  ): Promise<CapsuleResult> {
    const invalid: CapsuleResult = {
      capsule: { status: 'invalid' },
      findings: ['capsule-inspection-failed'],
    };
    const manifest = capsuleBinding.safeParse(binding.manifest);
    if (!manifest.success || binding.contract !== CAPSULE_CONTRACT)
      return invalid;
    const key = `${snapshot.did}\n${manifest.data.cid}`;
    let bytes: Uint8Array;
    try {
      // Read even on a cache hit: a private manifest must be re-authorized.
      bytes = await this.bytes(
        {
          did: snapshot.did,
          uri: manifest.data.uri,
          cid: manifest.data.cid,
          private: snapshot.anchor?.private ?? true,
          maxBytes: INDEX_MAX_BYTES,
        },
        transport,
        signal,
      );
    } catch {
      signal?.throwIfAborted();
      return {
        capsule: { status: 'unavailable', cid: manifest.data.cid },
        findings: ['capsule-unavailable'],
      };
    }
    const cached = parsed.capsules.get(key);
    if (cached) return cached;
    const result = await this.validateCapsule(snapshot, manifest.data, bytes);
    parsed.capsules.set(key, result);
    return result;
  }

  private async validateCapsule(
    snapshot: DomainSnapshot,
    manifest: z.infer<typeof capsuleBinding>,
    bytes: Uint8Array,
  ): Promise<CapsuleResult> {
    const invalid: CapsuleResult = {
      capsule: { status: 'invalid', cid: manifest.cid },
      findings: ['capsule-inspection-failed'],
    };
    const result = await domainValidator.validateOracleCapsule(bytes, {
      expectedIdentity: { cid: manifest.cid, sha256: manifest.sha256 },
    });
    const parsed = record(result.manifest);
    const oracle = record(record(parsed.domains).oracle);
    if (
      !result.ok ||
      record(parsed.metadata).release !== manifest.version ||
      parsed.schema !== manifest.schema ||
      oracle.id !== snapshot.did
    )
      return invalid;
    const compatibility = record(parsed.compatibility);
    const components = Array.isArray(parsed.components)
      ? parsed.components.map(record)
      : [];
    const master = components.find(
      (component) => component.kind === 'master_skill',
    );
    const findings: string[] = [];
    if (oracle.cid !== snapshot.anchor?.cid)
      findings.push('capsule-oracle-revision-differs');
    return {
      capsule: {
        status: 'inspected-not-activated',
        cid: manifest.cid,
        release: manifest.version,
        minimumKernel: String(compatibility.minimum_kernel ?? '').slice(0, 128),
        requiredFeatures: Array.isArray(compatibility.required_features)
          ? compatibility.required_features
              .filter((value): value is string => typeof value === 'string')
              .slice(0, 16)
              .map((value) => value.slice(0, 256))
          : [],
        master: master
          ? {
              id: String(master.id).slice(0, 256),
              cid: String(record(master.artifact).cid).slice(0, 128),
              entrypoint: String(master.entrypoint).slice(0, 256),
            }
          : undefined,
        requestedToolCount: Array.isArray(parsed.tools)
          ? parsed.tools.length
          : 0,
        externalChecksRequired: boundFindings(
          result.externalChecksRequired.map((check) => check.code),
        ),
      },
      findings,
    };
  }
}
