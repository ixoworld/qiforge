import type { DomainDocument } from '@ixo/domain.md/workers';
import type { RuntimeContext } from '../../plugin-api/types';

export interface DomainContextOptions {
  mode: 'off' | 'observe';
  anchorTtlMs?: number;
  allowedOrigins?: string[];
  ipfsGateway?: string;
  /** Host adapter must authorize every private read and return exact plaintext bytes. */
  readPrivateDocument?: (
    request: DocumentRequest,
    context: RuntimeContext,
    signal?: AbortSignal,
  ) => Promise<Uint8Array>;
}
export interface DocumentRequest {
  did: string;
  uri: string;
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
  source: string;
}
export interface DomainSnapshot {
  did: string;
  status: 'verified' | 'missing' | 'unavailable' | 'invalid';
  stale: boolean;
  anchor?: DomainAnchor;
  document?: DomainDocument;
  findings: string[];
  documentsRead?: Array<{ id: string; cid: string }>;
  capsule?: {
    status: 'inspected-not-activated' | 'invalid' | 'unavailable';
    cid?: string;
    release?: string;
    minimumKernel?: string;
    requiredFeatures?: string[];
    master?: { id: string; cid: string; entrypoint: string };
    requestedToolCount?: number;
    externalChecksRequired?: string[];
  };
}
export interface DomainTransport {
  isPublic?(request: DocumentRequest): boolean;
  resolve(did: string, signal?: AbortSignal): Promise<DomainAnchor | null>;
  read(request: DocumentRequest, signal?: AbortSignal): Promise<Uint8Array>;
}
