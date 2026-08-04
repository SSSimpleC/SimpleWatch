export interface CatalogEntry {
  readonly localId: string;
  readonly relativePath: string;
  readonly displayName: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly revision: string;
}

export interface CloudCatalogEntry {
  readonly localId: string;
  readonly relativePath: string;
  readonly displayName: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export interface CatalogPagePayload {
  readonly scanId: string;
  readonly generation: number;
  readonly pageIndex: number;
  readonly entries: readonly CloudCatalogEntry[];
}

export interface SourceIdentity {
  readonly catalogItemId: string;
  readonly catalogVersionId: string;
  readonly localId: string;
  readonly expectedBytes: number;
  readonly expectedMtimeMs: number;
  readonly expectedSha256: string | null;
}

export type EdgeTaskPayload = EdgeAgentTaskPayload;
export type EdgeTask = EdgeClaimedJob;
export type TusCredential = EdgeTusCredential;

export interface UploadProgress {
  readonly offset: number;
  readonly totalBytes: number;
}

export interface UploadResult extends UploadProgress {
  readonly sha256: string;
  readonly mtimeMs: number;
}

export interface StoredUpload {
  readonly jobId: string;
  readonly localId: string;
  readonly sourceRevision: string;
  readonly uploadUrl: string;
  readonly edgeTransferId: string;
  readonly uploadId: string;
  readonly uploadToken: string;
  readonly credentialExpiresAt: number;
  readonly credentialRefreshAfter: number;
  readonly chunkBytes: number;
  readonly offset: number;
  readonly totalBytes: number;
  readonly updatedAt: number;
}
import type {
  EdgeAgentTaskPayload,
  EdgeClaimedJob,
  EdgeTusCredential,
} from "@simplewatch/contracts";
