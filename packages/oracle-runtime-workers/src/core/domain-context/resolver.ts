import { lint, validateOracleCapsule } from '@ixo/domain.md/workers';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { z } from 'zod';
import type {
  DomainAnchor,
  DomainSnapshot,
  DomainTransport,
  DocumentRequest,
} from './types';

export const documentEntry = z.object({
  id: z.string(),
  uri: z.string().nullable(),
  cid: z.string().nullable(),
  required_for_tasks: z.array(z.string()).optional(),
  freshness: z
    .object({
      last_verified: z.string().nullable(),
      max_age: z.string().nullable(),
    })
    .optional(),
  role: z.string(),
  media_type: z.string(),
  disclosure_pass: z.number(),
  sensitivity: z.string(),
  access_policy: z.string(),
  agent_use: z.object({
    read: z.boolean(),
    cite: z.boolean(),
    summarize: z.boolean(),
  }),
});
const entriesSchema = z.object({ entries: z.array(documentEntry) });
export function entries(snapshot: DomainSnapshot) {
  const result = entriesSchema.safeParse(
    snapshot.document?.frontmatter.documents,
  );
  return result.success ? result.data.entries : [];
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : {};
}
export async function verifyBytes(
  bytes: Uint8Array,
  cid: string,
): Promise<void> {
  const expected = CID.parse(cid);
  if (
    expected.version !== 1 ||
    expected.code !== 0x55 ||
    expected.multihash.code !== 0x12
  )
    throw new Error('unsupported-cid-codec');
  const digest = await sha256.digest(bytes);
  if (!CID.createV1(0x55, digest).equals(expected))
    throw new Error('cid-mismatch');
}
export function decode(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    throw new Error('utf8-bom');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
    bytes,
  );
}

function waitFor<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
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

/** Per-user DO cache: anchors are shared across sessions, private content is not. */
export class DomainContextResolver {
  private anchors = new Map<
    string,
    { anchor: DomainAnchor | null; checked: number }
  >();
  private pending = new Map<string, Promise<DomainAnchor | null>>();
  private content = new Map<string, Uint8Array>();
  private contentBytes = 0;
  constructor(private readonly now = Date.now) {}
  invalidate(did: string): void {
    this.anchors.delete(did);
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
      // Shared lookup owns its timeout; one cancelled subscriber must not cancel other sessions.
      pending = transport
        .resolve(did, AbortSignal.timeout(10_000))
        .then((anchor) => {
          if (this.anchors.size >= 32)
            this.anchors.delete(this.anchors.keys().next().value ?? '');
          this.anchors.set(did, { anchor, checked: this.now() });
          return anchor;
        })
        .finally(() => this.pending.delete(did));
      this.pending.set(did, pending);
    }
    try {
      return { value: await pending, stale: false };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('invalid-anchor')
      ) {
        this.anchors.delete(did);
        throw error;
      }
      if (old?.anchor) return { value: old.anchor, stale: true };
      throw error;
    }
  }
  async bytes(
    request: DocumentRequest,
    transport: DomainTransport,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const cacheable =
      !request.private && (transport.isPublic?.(request) ?? true);
    const cached = cacheable && this.content.get(request.cid);
    if (cached) {
      if (cached.length > request.maxBytes)
        throw new Error('document-too-large');
      return cached;
    }
    const bytes = await transport.read(request, signal);
    if (bytes.length > request.maxBytes) throw new Error('document-too-large');
    await verifyBytes(bytes, request.cid);
    if (cacheable && bytes.length <= 2 * 1024 * 1024) {
      while (this.contentBytes + bytes.length > 8 * 1024 * 1024) {
        const key = this.content.keys().next().value;
        if (!key) break;
        this.contentBytes -= this.content.get(key)?.length ?? 0;
        this.content.delete(key);
      }
      if (!this.content.has(request.cid)) {
        this.content.set(request.cid, bytes);
        this.contentBytes += bytes.length;
      }
    }
    return bytes;
  }
  async load(
    did: string,
    transport: DomainTransport,
    ttl = 300_000,
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
      if (!/^did:ixo:[^\s#/?]+(?::[^\s#/?]+)*$/.test(did))
        throw new Error('invalid-anchor-did');
      const resolved = await waitFor(this.anchor(did, transport, ttl), signal);
      signal?.throwIfAborted();
      if (!resolved.value)
        return { ...snapshot, status: 'missing', findings: ['anchor-missing'] };
      snapshot.anchor = resolved.value;
      snapshot.stale = resolved.stale;
      const bytes = await this.bytes(
        { ...resolved.value, maxBytes: 1024 * 1024 },
        transport,
        signal,
      );
      const report = lint(decode(bytes));
      snapshot.findings = report.findings.map((f) => f.code);
      if (!report.ok || !report.document) {
        snapshot.status = 'invalid';
        return snapshot;
      }
      const front = report.document.frontmatter;
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
      snapshot.document = report.document;
      snapshot.findings.push(
        ...report.externalChecksRequired.map(
          (check) => `unresolved:${check.code}`,
        ),
      );
      if (snapshot.stale) snapshot.findings.push('anchor-stale');
      const binding = record(front['x-oracle-capsule']);
      if (Object.keys(binding).length)
        await this.inspectCapsule(snapshot, binding, transport, signal);
      return snapshot;
    } catch (error) {
      signal?.throwIfAborted();
      const reason =
        error instanceof Error ? error.message : 'resolution-failed';
      snapshot.status = /mismatch|invalid|unsupported|unanchored|utf8/.test(
        reason,
      )
        ? 'invalid'
        : 'unavailable';
      snapshot.findings.push(
        /^[a-z][a-z0-9-]{1,70}$/.test(reason) ? reason : 'resolution-failed',
      );
      delete snapshot.document;
      return snapshot;
    }
  }
  private async inspectCapsule(
    snapshot: DomainSnapshot,
    binding: Record<string, unknown>,
    transport: DomainTransport,
    signal?: AbortSignal,
  ) {
    try {
      const manifest = z
        .object({
          uri: z.string(),
          cid: z.string(),
          sha256: z.string(),
          version: z.string(),
          schema: z.string(),
          media_type: z.literal('application/vnd.ixo.oracle-capsule+json'),
        })
        .parse(binding.manifest);
      if (binding.contract !== 'ixo.earth/oracle-capsule/v0alpha1')
        throw new Error('capsule-contract');
      const bytes = await this.bytes(
        {
          did: snapshot.did,
          ...manifest,
          private: snapshot.anchor?.private ?? true,
          maxBytes: 1024 * 1024,
        },
        transport,
        signal,
      );
      const result = validateOracleCapsule(bytes, {
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
        throw new Error('capsule-binding-mismatch');
      const compatibility = record(parsed.compatibility);
      const components = Array.isArray(parsed.components)
        ? parsed.components.map(record)
        : [];
      const master = components.find(
        (component) => component.kind === 'master_skill',
      );
      snapshot.capsule = {
        minimumKernel: String(compatibility.minimum_kernel ?? '').slice(0, 128),
        requiredFeatures: Array.isArray(compatibility.required_features)
          ? compatibility.required_features
              .filter((v): v is string => typeof v === 'string')
              .slice(0, 16)
              .map((v) => v.slice(0, 256))
          : [],
        master: master
          ? {
              id: String(master.id).slice(0, 256),
              cid: String(record(master.artifact).cid),
              entrypoint: String(master.entrypoint).slice(0, 256),
            }
          : undefined,
        requestedToolCount: Array.isArray(parsed.tools)
          ? parsed.tools.length
          : 0,
        status: 'inspected-not-activated',
        cid: manifest.cid,
        release: manifest.version,
        externalChecksRequired: result.externalChecksRequired.map(
          (c) => c.code,
        ),
      };
      if (oracle.cid !== snapshot.anchor?.cid)
        snapshot.findings.push('capsule-oracle-revision-differs');
    } catch {
      signal?.throwIfAborted();
      snapshot.capsule = { status: 'invalid' };
      snapshot.findings.push('capsule-inspection-failed');
    }
  }
}
