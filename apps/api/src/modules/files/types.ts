import type { ScopeGrant } from '@emporium/domain/identity';
import type { FileOperation } from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { Db };

/** Who is acting; the owning module's check may look at roles and scopes. */
export interface FileActor {
  userId: string;
  roles: readonly string[];
  scopes: readonly ScopeGrant[];
  permissions: ReadonlySet<string>;
  requestId: string | null;
}

/** BR-4: each module decides who may touch the files of its own entity type. */
export type FileAccessCheck = (request: {
  actor: FileActor;
  entityId: string;
  operation: FileOperation;
  db: Db;
}) => Promise<boolean>;

export interface FileAccessOptions {
  /** BR-5: financial documents keep their files after removal. */
  retainForever?: boolean;
}

export interface UploadInput {
  entityType: string;
  entityId: string;
  fileName: string;
  bytes: Uint8Array;
  caption?: string | null;
  takenAt?: Date | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface AttachmentDto {
  id: string;
  entityType: string;
  entityId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  caption: string | null;
  takenAt: string | null;
  latitude: number | null;
  longitude: number | null;
  uploadedBy: string;
  createdAt: string;
  version: number;
}

export interface SignedUrl {
  url: string;
  expiresAt: string;
}
