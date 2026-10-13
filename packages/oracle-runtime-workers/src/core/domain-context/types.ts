/**
 * Observe-only domain context: the oracle's constitution domain and the
 * subject's domain, each a `domain.md` index anchored on its IID document as
 * the linked resource `<did>#dom`, verified by CID and statically validated,
 * then handed to the model as retrieved data. Nothing here grants authority,
 * activates a capsule or changes what the turn may do.
 */
import type { DomainDocument } from '@ixo/domain.md/workers';
import type { RuntimeContext } from '../../plugin-api/types';

export interface DomainContextOptions {
  mode: 'off' | 'observe';
  /** How long a resolved IID anchor is reused before Blocksync is asked again. Default 300 000. */
  anchorTtlMs?: number;
  /** Extra https origins documents may be fetched from (the VFS, Matrix and IPFS gateway origins are added). */
  allowedOrigins?: string[];
  /** https gateway used for `ipfs://` URIs; `ipfs://` documents are refused without one. */
  ipfsGateway?: string;
  /** Bounds of the documents read before the first model call. */
  pass1?: {
    /** Pass-1 documents read per domain. Default 4. */
    maxDocuments?: number;
    /** Token bound of each domain brief and of all pass-1 excerpts together. Default 6000. */
    maxTokens?: number;
    /** One overall bound for every pass-1 read of the turn. Default 3000. */
    timeoutMs?: number;
  };
  /**
   * Host adapter for private documents that are not VFS files. It must
   * authorize every call (it is called again on every read: private bytes
   * are never served from a cache) and return the exact plaintext bytes the
   * anchor's CID names.
   */
  readPrivateDocument?: (
    request: DocumentRequest,
    ctx: RuntimeContext,
    signal?: AbortSignal,
  ) => Promise<Uint8Array>;
}

export interface DocumentRequest {
  did: string;
  uri: string;
  /** CIDv1, raw codec, sha2-256 of the exact bytes. */
  cid: string;
  private: boolean;
  maxBytes: number;
}

export interface DomainAnchor {
  did: string;
  cid: string;
  uri: string;
  private: boolean;
  resolvedAt: number;
  /** Where the anchor came from: the Blocksync URL, or `durable-run-pin`. */
  source: string;
}

export interface DomainCapsuleInspection {
  /** Never `activated`: a capsule manifest is inspected only. */
  status: 'inspected-not-activated' | 'invalid' | 'unavailable';
  cid?: string;
  release?: string;
  minimumKernel?: string;
  requiredFeatures?: string[];
  master?: { id: string; cid: string; entrypoint: string };
  requestedToolCount?: number;
  externalChecksRequired?: string[];
}

export interface DomainDocumentRead {
  id: string;
  cid: string;
}

export interface DomainSnapshot {
  did: string;
  status: 'verified' | 'missing' | 'unavailable' | 'invalid';
  /** A failed refresh fell back to the last verified anchor. */
  stale: boolean;
  anchor?: DomainAnchor;
  /** Present only when `status` is `verified`. */
  document?: DomainDocument;
  /** Stable machine codes (validator findings, `unresolved:<check>`, resolver outcomes). */
  findings: string[];
  documentsRead?: DomainDocumentRead[];
  capsule?: DomainCapsuleInspection;
}

/** Anchors a durable run started with, so a resumed run keeps its revision. Keyed by DID. */
export type DomainContextPins = Record<
  string,
  { cid: string; uri: string; private: boolean }
>;

/** What a turn records and emits about the domain context it was given. */
export interface DomainContextProvenance {
  did: string;
  status: DomainSnapshot['status'];
  stale: boolean;
  cid?: string;
  resolvedAt?: number;
  source?: string;
  findings: string[];
  capsule?: DomainCapsuleInspection;
  /** Only integrity (CID) and static validation were checked — no live authority, time or revocation. */
  assurance: 'integrity-and-static-validation-only';
  documentsRead?: DomainDocumentRead[];
}

export interface DomainTransport {
  /** False when a non-private request still travels on authenticated access (so it must not be cached). */
  isPublic?(request: DocumentRequest): boolean;
  /** The `<did>#dom` anchor; `null` when the IID has none. Throws `invalid-anchor-*` for a malformed anchor. */
  resolve(did: string, signal?: AbortSignal): Promise<DomainAnchor | null>;
  /** Bytes at `request.uri`, at most `request.maxBytes`. The caller verifies the CID. */
  read(request: DocumentRequest, signal?: AbortSignal): Promise<Uint8Array>;
}
